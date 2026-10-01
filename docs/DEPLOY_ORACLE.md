# Deploy na Oracle Cloud (VM Always Free + PM2)

O backend (API + worker `MarketPollerService`) roda em **um único processo** PM2 numa VM Oracle,
atrás do Nginx. O dashboard continua na Vercel e chama a API pelo servidor (`/api/backend/*`).

| | |
|---|---|
| VM | `VM.Standard.E2.1.Micro` (1 OCPU, 1 GB RAM + 2 GB swap), Ubuntu 22.04, usuário `ubuntu` |
| IP público | `137.131.162.89` |
| Diretório | `/home/ubuntu/krypto/backend` |
| Processo | `krypto-backend` → `127.0.0.1:8000` (fork, 1 instância) |
| Monitoramento | `krypto-watchdog` (PM2, a cada 5 min) + monitor externo em `/health` (seção 8) + GitHub Actions `heartbeat-watchdog` (opcional, só manual por enquanto) |
| Arquivos | [`ecosystem.config.js`](../ecosystem.config.js), [`scripts/deploy.sh`](../scripts/deploy.sh), [`.env.example`](../.env.example) |

> **Nunca rode dois workers.** Com o Render e a VM ativos ao mesmo tempo, cada candle é avaliado e
> operado duas vezes no mesmo banco. Siga a ordem do passo 4 (suspender o Render antes de subir o PM2).

---

## 1. Pré-requisitos na VM

Node.js 22 LTS é o recomendado (o mesmo do `Dockerfile`). O Node 20 funciona, mas está fora de suporte desde abril de 2026.
O pnpm vem pelo corepack, na versão fixada em `packageManager` no `package.json`. Não precisa instalar globalmente.

```bash
node -v            # >= 20.6 (o watchdog usa --env-file)
pm2 -v
corepack pnpm -v   # baixa o pnpm fixado na primeira vez
free -h            # confirme os 2 GB de swap
```

## 2. Testar o acesso à Binance a partir da VM

```bash
curl -s -o /dev/null -w "%{http_code}\n" https://api.binance.com/api/v3/ping          # 200 = ok
curl -s -o /dev/null -w "%{http_code}\n" https://data-api.binance.vision/api/v3/ping  # alternativa
curl -s -o /dev/null -w "%{http_code}\n" https://fapi.binance.com/fapi/v1/ping        # funding scanner
```

- Se `api.binance.com` responder **451/403**, use `MARKET_DATA_BASE_URL=https://data-api.binance.vision`
  no `.env`. É o mesmo market data público, somente leitura.
- Se `fapi.binance.com` estiver bloqueado, use `FUNDING_SCAN_ENABLED=false`.

## 3. Primeiro deploy

```bash
mkdir -p ~/krypto && cd ~/krypto
git clone https://github.com/jacksonn455/cripto-bot-backend.git backend
cd backend

cp .env.example .env
chmod 600 .env
nano .env
```

No `.env`, copie **os mesmos valores que estão hoje em Render > Environment**, para manter o
comportamento idêntico. Ajuste só o que muda com a VM:

```dotenv
NODE_ENV=production
PORT=8000
HOST=127.0.0.1
CORS_ORIGINS=
TRADING_MODE=PAPER
LIVE_TRADING_CONFIRMED=false
EXECUTION_ENABLED=true
API_KEY_REQUIRED_FOR_ALL=true
SWAGGER_ENABLED=false
KRYPTO_ENVIRONMENT=PRODUCTION
MONGO_URI=...            # obrigatório em produção
CONTROL_API_KEY=...      # >= 32 caracteres (o mesmo API_KEY configurado na Vercel)
REDIS_URL=...
DISCORD_ENABLED=true
DISCORD_WEBHOOK_URL=...
```

Instale e faça o build **sem iniciar** o processo ainda:

```bash
corepack pnpm install --frozen-lockfile
NODE_OPTIONS=--max-old-space-size=768 corepack pnpm run build
mkdir -p logs
```

## 4. Cutover: desligar o Render e subir a VM

1. No Render, **suspenda** o web service `cripto-bot-backend` e o cron job `cripto-bot-watchdog`.
   Use Settings > Suspend; depois de validar a VM, pode apagar os dois.
2. Na VM:

   ```bash
   cd ~/krypto/backend
   pm2 start ecosystem.config.js --env production
   pm2 save
   pm2 startup systemd -u ubuntu --hp /home/ubuntu   # copie e rode o comando "sudo env PATH=..." que ele imprimir
   pm2 save
   ```

3. Rotação de logs (o disco é pequeno):

   ```bash
   pm2 install pm2-logrotate
   pm2 set pm2-logrotate:max_size 10M
   pm2 set pm2-logrotate:retain 7
   pm2 set pm2-logrotate:compress true
   ```

4. Verifique:

   ```bash
   curl -s http://127.0.0.1:8000/health    # "status":"ok", worker.loop "running" (ou "starting" no primeiro minuto)
   pm2 status                              # krypto-backend online, 1 instância; krypto-watchdog "stopped" entre execuções é normal
   ```

   No Discord deve chegar o aviso de restart/recovery do worker.

## 5. Atualizações

```bash
bash ~/krypto/backend/scripts/deploy.sh
```

O script faz `git pull --ff-only` (branch `master`, ou `DEPLOY_BRANCH`), `pnpm install --frozen-lockfile`,
build com o heap limitado, `pm2 startOrReload` e `pm2 save`. Depois espera o `/health` responder, por até 60 s,
e falha se o processo não subir, se o loop travar (503) ou se o MongoDB estiver inacessível (`"status":"down"`).

Em fork mode, o reload é um restart: o processo recebe SIGINT, para o poller, grava `stopped` no
heartbeat e fecha Mongo/Redis (`kill_timeout` de 10 s) antes de subir o novo.

## 6. Comandos úteis

```bash
pm2 status
pm2 logs krypto-backend              # --lines 200 / --err
pm2 logs krypto-watchdog --lines 20  # deve mostrar "result=ok" a cada 5 min
pm2 restart krypto-backend
pm2 monit
pm2 describe krypto-backend          # restarts, memória, uptime
```

Nunca use `pm2 scale` nem `-i`: o backend precisa ser **uma única instância**.

Se o `krypto-watchdog` não rodar sozinho a cada 5 min (o log não avança), troque o `cron_restart`
do PM2 por um crontab do sistema (`crontab -e`):

```cron
*/5 * * * * cd /home/ubuntu/krypto/backend && NODE_ENV=production /usr/bin/node --env-file=.env dist/watchdog/heartbeat-watchdog.js >> logs/krypto-watchdog.cron.log 2>&1
```

## 7. Nginx (reverse proxy + WebSocket)

`/etc/nginx/sites-available/krypto`:

```nginx
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

server {
    listen 80;
    server_name api.seudominio.com;   # troque pelo seu domínio

    location / {
        proxy_pass http://127.0.0.1:8000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 120s;      # agentes de IA podem levar até ~90 s
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/krypto /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d api.seudominio.com
```

O app usa `trust proxy = 1`, ou seja, confia em um salto (o Nginx) para `X-Forwarded-*`.

**Firewall da imagem Ubuntu da Oracle:** além da Security List, a imagem vem com regras de `iptables`
que bloqueiam 80/443. Libere as portas:

```bash
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 80 -j ACCEPT
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 443 -j ACCEPT
sudo netfilter-persistent save
```

A porta 8000 **não** deve ser aberta: o app só escuta em `127.0.0.1`.

## 8. Monitor externo (recomendado)

O `krypto-watchdog` roda na própria VM. Se a VM inteira cair (ou o Nginx parar), ninguém avisa.
Configure um monitor HTTP gratuito de fora da Oracle:

- **UptimeRobot** (free: checagem a cada 5 min) ou **Better Stack Uptime** (free: a cada 3 min).
- URL: `https://<seu-domínio>/health`, método GET, sem headers (`/health` dispensa a API key).
- Condição de alerta: status diferente de 2xx. Opcionalmente use keyword monitor exigindo
  `"status":"ok"`, o que também acusa Mongo fora (`"status":"down"` responde 200).
- `/health` devolve 503 quando o loop do worker trava, então o monitor também pega worker parado.
- Alerta por e-mail, ou pelo Discord via webhook, se o serviço permitir.

## 9. Checklist

**Oracle**
- [ ] Security List da subnet com ingress TCP 80 e 443 (0.0.0.0/0); 22 de preferência só do seu IP
- [ ] `iptables` liberado para 80/443 (seção 7)

**MongoDB Atlas (Network Access)**
- [ ] `137.131.162.89/32` adicionado
- [ ] Watchdog do GitHub Actions: os runners não têm IP fixo, então ele só conecta se o Atlas aceitar
  `0.0.0.0/0`. Se você não quiser isso, desative o workflow e fique só com o watchdog do PM2. Se mantiver, use
  um usuário do Atlas exclusivo para o watchdog, com senha forte (ele precisa de `readWrite` no banco do bot
  para abrir e fechar o incidente `WORKER_OFFLINE`).
- [ ] Remova as entradas antigas do Render, se houver

**Redis (Upstash)**
- [ ] Se o banco tiver IP allowlist, adicione `137.131.162.89`. Sem allowlist, nada a fazer.

**Vercel (frontend)**
- [ ] `API_URL=https://api.seudominio.com` (variável server-side lida em `lib/server-env.ts`)
- [ ] `API_KEY` igual ao `CONTROL_API_KEY` do `.env` da VM
- [ ] Redeploy do frontend para aplicar

**Backend**
- [ ] `CORS_ORIGINS` vazio, porque o navegador não chama a API diretamente. Preencha com o domínio da Vercel
  (sem `*`) só se isso mudar.
- [ ] `TRADING_MODE=PAPER` e `LIVE_TRADING_CONFIRMED=false`

**Monitor externo**
- [ ] UptimeRobot ou Better Stack apontando para `https://<seu-domínio>/health` (seção 8)

**GitHub Actions `heartbeat-watchdog` (opcional)**

O workflow está **só com `workflow_dispatch`**: o bloco `schedule` está comentado. Ele só deve ser
reativado quando as duas condições forem verdadeiras:

- [ ] os secrets `MONGO_URI` e `DISCORD_WEBHOOK_URL` estão em Settings > Secrets and variables > Actions;
- [ ] o Atlas aceita as conexões dos runners do GitHub (veja o item do `0.0.0.0/0` acima).

Para ativar:
- [ ] rode Actions > heartbeat-watchdog > Run workflow uma vez e confira `result=ok` no log;
- [ ] descomente o bloco `schedule` no `.yml` e faça commit.

O GitHub pausa schedules depois de 60 dias sem atividade no repositório.

**Render**
- [ ] Web service e cron job suspensos ou apagados. A configuração antiga está em `docs/legacy/render.yaml`,
  só como referência.

## 10. CI/CD por SSH (documentado, ainda não implementado)

Quando o deploy manual estiver estável, dá para disparar o `scripts/deploy.sh` a cada push na `master`:

1. Na sua máquina, gere uma chave só para deploy: `ssh-keygen -t ed25519 -f krypto_deploy -C github-deploy`.
2. Na VM, adicione `krypto_deploy.pub` ao `~/.ssh/authorized_keys` do `ubuntu`.
3. No GitHub, crie os secrets `ORACLE_HOST` (`137.131.162.89`), `ORACLE_USER` (`ubuntu`) e
   `ORACLE_SSH_KEY` (o conteúdo da chave **privada**). Nunca coloque a chave no repositório.
4. Crie `.github/workflows/deploy.yml`:

```yaml
name: deploy
on:
  push:
    branches: [master]
concurrency:
  group: deploy
  cancel-in-progress: false
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: appleboy/ssh-action@v1
        with:
          host: ${{ secrets.ORACLE_HOST }}
          username: ${{ secrets.ORACLE_USER }}
          key: ${{ secrets.ORACLE_SSH_KEY }}
          script: bash /home/ubuntu/krypto/backend/scripts/deploy.sh
```

A porta 22 precisa aceitar os IPs dos runners do GitHub, que não são fixos. Isso conflita com restringir o SSH ao
seu IP. Por isso o deploy continua manual por enquanto.
