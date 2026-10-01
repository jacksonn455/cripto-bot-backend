# Documentação técnica — Trade Bot Backend

> Este arquivo reúne todo o conteúdo técnico do projeto (arquitetura, endpoints, schemas,
> scripts, decisões de implementação e detalhes fase a fase). Se você quer entender **o que
> o bot faz e se é seguro**, sem jargão, veja o [README.md](../README.md) principal.

## Índice

1. [Requisitos](#requisitos)
2. [Como rodar](#como-rodar)
3. [Scripts](#scripts)
4. [Regras de segurança (versão técnica)](#regras-de-segurança-versão-técnica)
5. [Arquitetura de código](#arquitetura-de-código)
6. [Dados de mercado vs. execução](#dados-de-mercado-vs-execução)
7. [Por que `@binance/connector`](#por-que-binanceconnector)
8. [Cache com Redis (reports/charts)](#cache-com-redis-reportscharts)
9. [Por que não RabbitMQ (por enquanto)](#por-que-não-rabbitmq-por-enquanto)
10. [Modelagem MongoDB](#modelagem-mongodb)
11. [Endpoints REST](#endpoints-rest)
12. [Roadmap por fases (detalhado)](#roadmap-por-fases-detalhado)
13. [Testes](#testes)
14. [Licença](#licença)

---

## Requisitos

- Node.js 22+
- pnpm (veja nota abaixo se `pnpm` não estiver no seu PATH)
- Docker + Docker Compose (opcional, para rodar app + MongoDB + Redis juntos)

> Nota Windows + nvm-windows: se `node`/`npm` estiverem em `Program Files`, instalações globais
> ali exigem admin. Em vez disso:
> `npm config set prefix "$env:APPDATA\npm"` depois `npm install -g pnpm`, e adicione
> `$env:APPDATA\npm` ao seu PATH.

## Como rodar

```powershell
cp .env.example .env
pnpm install

# MongoDB e Redis via Docker, app rodando local (watch mode)
docker compose up mongo redis -d
pnpm run start:dev
```

> `docker-compose.yml` só sobe `mongo` e `redis` — o app roda direto no terminal via
> `pnpm run start:dev`/`pnpm run start:prod`, não como container. O `Dockerfile` continua no
> repositório caso você queira containerizar o app depois.

Documentação Swagger: http://localhost:8000/docs

## Scripts

- `pnpm run start:dev` — modo watch
- `pnpm run build` — compila para `dist/`
- `pnpm test` — testes unitários (Jest)
- `pnpm test:e2e` — testes e2e (precisa de MongoDB acessível via `MONGO_URI`)
- `pnpm run lint` — oxlint
- `pnpm run seed` — popula 60 trades fake no Mongo (BTCUSDT/ETHUSDT, PAPER/BACKTEST, para testar
  relatórios sem precisar rodar o bot de verdade). Todas saem com `isSeed: true`, que o painel
  mostra como "SEED". `pnpm run seed -- --reset` apaga as trades seed anteriores antes de inserir.

## Regras de segurança (versão técnica)

1. **Modo padrão é PAPER.** O modo `LIVE` só liga com `TRADING_MODE=LIVE` **e**
   `LIVE_TRADING_CONFIRMED=true` no `.env`, ambos validados na inicialização (Joi). Sem isso o
   app nem sobe. Em `PAPER`, nenhuma ordem real é enviada — nunca, para lugar nenhum.
2. **Testnet por padrão** (`BINANCE_BASE_URL=https://testnet.binance.vision`). Mesmo em `LIVE`
   você continua na testnet a menos que troque deliberadamente para uma URL de produção.
   Isso vale só para **onde as ordens são enviadas** — os preços usados no modo `PAPER` vêm de
   uma fonte separada (veja "Dados de mercado vs. execução" abaixo).
3. Chaves de API só em variáveis de ambiente — nunca logadas, nunca salvas no banco. Use uma
   chave da Binance **sem permissão de saque**.
4. **Sinal → Risco → Execução**: a estratégia nunca chama a Binance diretamente. Ela emite um
   sinal, o `RiskModule` aprova ou veta, e só então o `ExecutionModule` envia a ordem.
5. Toda entrada exige stop loss. Em `LIVE`, o stop é uma ordem na exchange (stop-limit), não
   apenas lógica interna do bot.
6. `newClientOrderId` determinístico para idempotência (sem ordens duplicadas em retry/reconexão).
7. **Sem lookahead bias**: decisões usam apenas candles **fechados**.
8. Toda ordem passa pelos filtros da Binance (`LOT_SIZE`, `PRICE_FILTER`, `MIN_NOTIONAL`), com
   arredondamento correto de quantidade e preço.
9. Kill switch: endpoint que cancela ordens abertas, fecha posições e pausa o bot.

## Arquitetura de código

```
src/
  config/         # validação de env (Joi) + config factories tipadas
  database/       # conexão Mongoose
  cache/          # RedisCacheService (cache de reports/charts, fail-open, timeout e reconexão limitada)
  exchange/       # interface ExchangeGateway + Binance (testnet) + Paper
  market-data/    # candles históricos com paginação + cache Mongo (HistoricalCandlesService)
  strategy/       # interface Strategy + TrendRegimeStrategy + registry
  indicators/     # EMA, RSI, ATR (IndicatorsService)
  risk/           # RiskManager + schema/persistência de signals
  execution/      # sinal→risco→execução, stop na exchange, reconciliação, User Data Stream
  trades/         # consultas de trades/ordens (schemas Mongoose + TradesModule)
  backtest/       # engine de backtest (puro) + walk-forward + persistência
  reports/        # métricas (PnL, drawdown, Sharpe...) e agregações Mongo, cacheadas no Redis
  funding/        # scanner de funding rate (somente leitura, agendado)
  control/        # bot_state, pause/resume/kill switch, auto-pausa por limites de risco
  notifications/  # NotificationProvider: Discord (embeds) e Telegram, disparados por eventos de domínio
  ai/             # OpenAI Agents: agentes de análise com ferramentas somente leitura
  events/         # ponte de eventos de domínio -> SSE para o painel
```

`ExchangeGateway` é o único ponto de contato entre o resto do app e a Binance. Estratégia e
RiskManager só falam com essa interface — nunca diretamente com a Binance.

## Dados de mercado vs. execução

No modo `PAPER`, o dinheiro é **100% fictício** — um saldo em memória, seedado por
`PAPER_INITIAL_BALANCE_AMOUNT`, sem nenhuma ordem real sendo enviada. Mas para o teste valer a
pena, os **preços usados nas compras/vendas simuladas precisam ser reais**. Por isso essas duas
URLs são independentes:

- `MARKET_DATA_BASE_URL` (padrão `https://api.binance.com`, produção): de onde o `PaperExchangeGateway`
  lê candles/preços — só endpoints públicos, sem chave, sem risco. É o que faz o paper trading
  refletir o mercado real em vez da testnet (que tem liquidez/preços diferentes).
- `BINANCE_BASE_URL` (padrão `https://testnet.binance.vision`): para onde ordens **reais** são
  roteadas quando `TRADING_MODE=LIVE`. Continua protegida pelo gate de segurança e não tem
  relação com de onde vêm os preços do paper trading.

Isso significa que os resultados que você vê hoje em `PAPER` já usam o preço real do mercado —
o que muda ao ir para `LIVE` é só o envio de ordens de verdade (com dinheiro de verdade),
não a qualidade dos dados usados para decidir.

## Por que `@binance/connector`

Escolhido em vez de `ccxt` por ser o cliente REST oficial da Binance, mapeando 1:1 os
endpoints/campos que precisamos acertar (filtros de ordem, `newClientOrderId`), e por
ter uma superfície bem menor que a abstração multi-exchange do ccxt. Ele não vem com tipos
TypeScript, então essa parte não tipada fica isolada em
[`BinanceRestClient`](../src/exchange/binance/binance-rest.client.ts) e numa declaração ambiente
local ([`binance-connector.d.ts`](../src/types/binance-connector.d.ts)) — nenhum outro lugar do
código toca a lib crua.

Ele também **não cobre a API de Futuros** — por isso o `FundingModule` (Fase 7) usa um cliente
HTTP próprio e minúsculo, via `fetch` nativo do Node.

## Cache com Redis (reports/charts)

Os endpoints de `ReportsModule` (`/reports/*`) rodam aggregation pipelines do Mongo a cada
chamada — ótimo para poucos usuários, mas repetitivo quando um dashboard fica atualizando
gráficos a cada poucos segundos. `RedisCacheService` ([src/cache](../src/cache)) resolve isso:

- **`getOrSet(key, ttlSeconds, factory)`**: cada método de `ReportsService` e
  `EquitySnapshotsService.findCurve` usa isso — cache miss aciona a query no Mongo normalmente e
  guarda o resultado; cache hit não toca o Mongo.
- **TTL curto e configurável** (`REPORTS_CACHE_TTL_SECONDS`, padrão 30s) — mesmo sem qualquer
  invalidação, o cache nunca fica desatualizado por mais que isso.
- **Invalidação ativa**: `ReportsService` escuta os eventos de domínio `trade.opened`/
  `trade.closed` (já emitidos pelo `ExecutionService` via `@nestjs/event-emitter`, ver Fase 6) e
  limpa todas as chaves `reports:*` assim que uma trade abre ou fecha — o dashboard não fica
  olhando dado velho esperando o TTL expirar. `EquitySnapshotsService.insertMany` faz o mesmo com
  `reports:equityCurve:*` sempre que novos pontos de equity são gravados.
- **Fail-open por design**: toda chamada ao Redis (`get`/`set`/`deleteByPrefix`) está em
  try/catch — se o Redis cair ou não estiver acessível, o serviço loga um aviso e trata como
  cache miss, caindo de volta para consultar o Mongo direto. Cache aqui é só performance, nunca
  uma dependência de corretude (mesma filosofia de fail-open usada com a Binance no resto do
  projeto).
- **`REDIS_URL`**: em uso, Upstash via TLS (`rediss://default:<token>@<db>.upstash.io:6379`, o token
  é o `UPSTASH_REDIS_REST_TOKEN`; em produção fica só no `.env` da VM). Local: `redis://localhost:6379`, ou `redis://redis:6379` dentro do Docker
  Compose) e **`REPORTS_CACHE_TTL_SECONDS`** (padrão `30`) ficam no `.env`.

### Redis: onde é usado e o que acontece sem ele

| Uso | Onde | Classificação | Sem Redis |
|---|---|---|---|
| Cache de `/reports/summary`, `by-strategy`, `by-symbol`, `by-side`, `by-hour`, `compare-modes` | `ReportsService` | Cache / performance | Consulta o Mongo direto (mesmo resultado, mais lento) |
| Cache de `/reports/equity-curve` | `EquitySnapshotsService` | Cache / performance | Consulta o Mongo direto |
| Invalidação `reports:*` em `trade.opened/closed`, `backtest.completed`, novos snapshots | `ReportsService`, `EquitySnapshotsService` | Cache | No-op (não há o que invalidar) |
| `GET /health` → `redis` | `HealthController` | Observabilidade | `status: "disabled"` (desligado de propósito) ou `ok: false` (fora do ar) → `degraded` |

**Nenhum fluxo depende obrigatoriamente do Redis**: estratégia, risco, execução, reconciliação, kill
switch e estado do bot (`bot_state`) vivem no Mongo e em memória. Por isso o fallback é sempre seguro.

Comportamento com o Redis fora do ar ou travado:

- **Sem fila offline**: comandos nunca ficam acumulando em memória esperando o Redis voltar.
- **Enquanto não está `ready`**, cada chamada é um *cache miss* imediato, sem erro e sem um log por request.
- **Timeout por comando** (`REDIS_COMMAND_TIMEOUT_MS`, padrão 500 ms): um Redis conectado mas travado custa
  no máximo isso por chamada antes do fallback, em vez de segurar a request.
- **Reconexão limitada**: backoff exponencial (0,5 s → 30 s) por `REDIS_MAX_RECONNECT_ATTEMPTS` (padrão 10,
  ≈2,5 min), depois desiste. A partir daí faz **no máximo uma tentativa a cada 5 min**, e só quando o cache é
  usado. Não há loop infinito e o Redis consegue voltar sozinho.
- **Logs com throttle**: `[Redis] unavailable - using fallback (...)` no máximo 1×/min; `[Redis] connected` /
  `reconnected`; *hit/miss* em nível `debug`.
- **Erros reais não são mascarados**: só erros do cache são engolidos. Se a query do Mongo (a `factory` do
  `getOrSet`) falhar, o erro propaga normalmente.
- `REDIS_ENABLED=false` (ou `REDIS_URL=`) desliga o cache sem tentar conectar. O painel mostra
  "desativado (opcional)" em vez de erro. Era essa a mensagem "indisponível" na antiga produção no Render, onde o
  cache está desligado de propósito.

## Long e Short

Fluxo idêntico para os dois lados — `SIGNAL → RISK → ENTRY → POSITION → EXIT → PNL → EVENT → REPORT`. O
lado só decide qual ordem abre/fecha e o sinal do PnL
([`position-math.util.ts`](../src/trades/position-math.util.ts), usado por execução, reconciliação, kill
switch e backtest):

| | LONG | SHORT |
|---|---|---|
| Regime (EMA200 no timeframe de regime) | close > EMA | close < EMA |
| Gatilho | EMA rápida cruza **acima** da lenta | EMA rápida cruza **abaixo** da lenta |
| Filtro RSI | `[rsiMin, rsiMax]` (45–70) | espelhado: `[100−rsiMax, 100−rsiMin]` (30–55) |
| Stop inicial | entrada − `atrStopMultiplier`×ATR | entrada + `atrStopMultiplier`×ATR |
| Saída por sinal | cruzamento para baixo | cruzamento para cima |
| Trailing (chandelier) | máxima(22) − 3×ATR | mínima(22) + 3×ATR |
| Ordem de entrada / saída | BUY / SELL | SELL / BUY |
| Stop intra-candle (paper/backtest) | `low ≤ stop` | `high ≥ stop` |
| PnL | `(saída − entrada) × qtd` | `(entrada − saída) × qtd` |
| `pnlPct` | `(saída − entrada)/entrada` | `(entrada − saída)/entrada` |

**Por que não havia Short (diagnóstico: caso A):** a estratégia simplesmente não tinha lógica de Short —
`ENTER_SHORT` existia no tipo `SignalAction`, mas nunca era emitido. Além disso, execução, backtest,
reconciliação, kill switch e equity estavam fixos em `LONG`/`BUY`/`SELL` e calculavam o PnL sempre como
long. Ou seja, mesmo que o sinal existisse, um short seria executado e contabilizado errado.

**Onde o Short roda:**

- `TREND_ALLOW_SHORT=true` liga o lado Short (**padrão `false`**: produção não muda sem evidência). Nos
  backtests, use `strategyParams: { "allowShort": 1 }`. Quando está em `0`, o parâmetro fica fora do hash,
  então rodadas long-only continuam com o mesmo hash de antes.
- **PAPER**: simulado. A carteira fica com saldo negativo do ativo base, e o poder de compra desconta o
  nocional do short como colateral 1:1. Não há modelagem de juros, funding ou liquidação.
- **LIVE (Binance Spot)**: **não é possível shortar no Spot**, porque não existe empréstimo do ativo. O
  gateway declara `supportsShortSelling = false` e o RiskManager veta com `SHORT_NOT_SUPPORTED` (fica
  registrado em `signals`) em vez de mandar um SELL a descoberto. Short real exigiria um gateway de Binance
  Margin (borrow/repay) ou USDⓈ-M Futures (alavancagem, funding, liquidação): é uma evolução separada.
- **Backtest**: `shortBorrowPctPerDay` (padrão 0,0003 = 0,03%/dia) cobra o custo de carregar o short.

Relatórios: `summary.bySide.{LONG,SHORT}`, `longCount/shortCount`, `GET /reports/by-side` e filtro `side`
em `/reports/*` e `/trades`. Eventos `trade.opened/closed` agora carregam lado, estratégia, timeframe,
preços, quantidade, PnL, % e motivo.

## Trava de stops consecutivos

Depois de `RISK_MAX_CONSECUTIVE_STOPS` (padrão 3) saídas por stop seguidas, o `RiskManager` veta novas entradas
(`CONSECUTIVE_STOPS_LIMIT`) e o `ControlService` auto-pausa o bot. A regra da sequência é uma só,
[`stop-streak.util.ts`](../src/risk/stop-streak.util.ts): uma saída por stop soma 1; qualquer outra saída zera.

- **Paper/Live:** a sequência é contada a partir das trades fechadas no Mongo **depois de `bot_state.stopStreakResetAt`**,
  que `POST /bot/resume` grava. Retomar o bot zera a sequência. Antes, o bot continuava vetando para sempre mesmo depois de
  retomado, porque os mesmos 3 stops continuavam sendo os mais recentes. O marco fica no Mongo, então um restart do
  processo (deploy ou restart do PM2) não zera nem desfaz nada. Posições abertas não são afetadas: a trava só bloqueia entradas.
- **Backtest:** ninguém retoma uma simulação, então a pausa dura até o próximo dia UTC (`stopPauses` na execução). Antes ela
  nunca acabava: o backtest de BTCUSDT de 01/04 a 30/09/2026 parou de operar depois do 3º stop, em 20/04.
- Depois do deploy, um bot que já estava travado continua travado até a primeira retomada manual (comportamento correto).

## Motor de backtest v2 e opções de pesquisa

`engineVersion: 2` em cada execução. Execuções de versões diferentes não se comparam: a tela de comparação e o PBO avisam.

- Um stop atravessado por gap preenche na **abertura** do candle (`costs.totalGapCost`, `costs.gappedStops`); antes,
  preenchia no preço do stop. Vale também para o stop local do PAPER.
- A pausa por stops seguidos expira no dia seguinte (acima).
- `stopSlippagePct`: slippage só das saídas por stop (inclusive trailing).
- `portfolioMode: true`: todos os símbolos num saldo único e num relógio comum, como o loop ao vivo. Combinado com
  `maxSameSideRiskPct`, limita o risco somado no mesmo sentido (veto `AGGREGATE_RISK_LIMIT`).
- `shortCarryModel: "funding"`: custo do short pelo funding histórico real do perpétuo (`funding_history`, cache de
  `/fapi/v1/fundingRate`).
- `regimeLookback`: candles de regime vistos por passo. O padrão é a janela do loop ao vivo (210), com a qual a "EMA200"
  fica perto de uma média simples. A variante de pesquisa V1 usa 1000.
- Parâmetros de estratégia só para pesquisa (fixos em 0 na config, **sem variável de ambiente**, para o paper/live não
  mudarem): `trailingMode` (1 = stop desde a entrada, dentro do candle, saída `TRAILING`) e `pullbackLookback`
  (entrada por pullback, regra em `ESTRATEGIA-PESQUISA.md` §5). Também `adxMin`/`adxPeriod` e `regimeBandPct`, desligados (0).
- Cada execução grava `riskAdjusted`: Sharpe/Sortino diários anualizados com 365 dias, Calmar, CAGR, volatilidade, PSR,
  assimetria e curtose. Na leitura, `overfitting` traz o Sharpe deflacionado (N = combinações testadas da estratégia,
  variância entre os Sharpes delas), o Sharpe esperado por sorte e o haircut de Harvey & Liu (Bonferroni).
- Resumos com `rStats`: R médio, mediana, histograma em R, trades ≥ 3R, fatia do lucro bruto dos 10% melhores trades e
  Kelly implícito (só diagnóstico).
- Janelas de walk-forward com `startBalance` e `returnPct`.

Endpoints novos:
- `GET /backtest/compare?baseline=&variant=`: janela a janela, fração das janelas em que a variante venceu (retorno,
  PF, expectância, e PF e expectância juntos), avisos de comparabilidade e "inconclusivo" com menos de 30 trades por lado.
- `GET /backtest/pbo?runIds=a,b,c`: Probability of Backtest Overfitting (CSCV) sobre 2 a 20 execuções com as mesmas janelas.

Harness da pesquisa: [`src/research/variants.research.spec.ts`](../src/research/variants.research.spec.ts).
`RUN_RESEARCH=1 pnpm test -- src/research` roda o protocolo V0–V3 inteiro com candles reais e sem banco, e grava
`docs/research/variants-results.json`. Fora isso, fica pulado.

## Notificações (Discord / Telegram)

A lógica de trading só emite eventos de domínio (`trade.opened`, `trade.closed`, `alert.critical`,
`bot.paused`, `bot.resumed`). O `NotificationsService` repassa cada evento a todos os
`NotificationProvider` habilitados que aceitam aquela categoria:

```
notifications/
  notification.types.ts          # NotificationProvider (interface), Notification, formatadores
  notifications.service.ts       # escuta os eventos e faz o fan-out (fire-and-forget)
  http-delivery.util.ts          # POST JSON com timeout, retry controlado, redaction de segredos
  discord/                       # DiscordNotificationProvider + formatador de embeds
  telegram/                      # TelegramNotificationProvider
```

- **Discord** (`DISCORD_ENABLED=true` + `DISCORD_WEBHOOK_URL`): embeds com lado, modo, timeframe,
  estratégia, entrada/saída, quantidade, nocional, stop, PnL, %, motivo, duração, taxas e timestamp. Verde
  para lucro, vermelho para prejuízo, azul/laranja na abertura de LONG/SHORT. O texto é truncado aos limites
  do Discord e o `allowed_mentions` é vazio (nada pinga @everyone).
- **Telegram**: mantém o comportamento anterior (liga com token + chat; só alertas por padrão). Agora com
  timeout e checagem da resposta.
- `DISCORD_EVENTS` / `TELEGRAM_EVENTS` escolhem as categorias por canal: `alerts` (alerta crítico, pausa,
  retomada), `trades` (abertura/fechamento), `reports` (resumo diário e backtest concluído) e `signals`
  (sinais de entrada vetados pelo risco). Incidentes operacionais seguem em `DISCORD_ALERTS_ENABLED`.
- **Resumo diário** (`notifications/daily-report/`): às `DAILY_REPORT_HOUR` no fuso `NOTIFICATIONS_TIME_ZONE`
  manda PnL realizado, trades, win rate, taxas, equity e variação em 24h, posições abertas, avaliações,
  sinais aprovados/vetados, incidentes ativos e estado do worker/bot. Também é o heartbeat diário: se a
  mensagem não chegar de manhã, algo está errado. Se o processo estava fora na hora marcada, o resumo sai
  assim que ele volta no mesmo dia. A coleção `daily_report_runs` (um documento por dia local) impede envio
  duplicado após restart.
- **Sinais vetados** (`SignalVetoDigestService`): agrupados em uma mensagem por janela de
  `SIGNAL_VETO_DIGEST_MINUTES` (contagem por motivo + últimos sinais). Sinais aprovados viram `trade.opened`.
- **Backtest concluído**: PnL, trades, win rate, profit factor, max drawdown, Sharpe e taxas.
- `bot.error` **não** vai para o Discord: as mesmas falhas do ciclo já viram incidente `EVALUATION`/`MARKET_DATA`
  (com limiar e cooldown), e mandar os dois duplicaria a mensagem.
- **Resiliência**: timeout por tentativa (`NOTIFICATIONS_TIMEOUT_MS`). Retry único só em 5xx, erro de conexão
  e 429 com `retry_after` ≤ 5 s. **Não** há retry em timeout, porque a mensagem pode ter sido entregue e uma
  duplicada é pior. Um 401/403/404 desliga o Discord até o próximo restart (webhook apagado ou URL errada). Os
  handlers retornam na hora, então um canal lento ou fora do ar nunca atrasa nem quebra um trade.
- **Segurança**: a URL do webhook e o token do Telegram nunca vão para log. Mensagens de erro passam por
  redaction e o log mostra só `discord.com/…/<id>`. As mensagens de validação do Joi não ecoam o valor.

## Camada de AI (OpenAI Agents)

```
ai/
  ai.module.ts / ai.controller.ts / ai.service.ts   # fachada, status, timeouts, concorrência, logs
  agents/agent-definitions.ts                       # os agentes especializados (prompt + ferramentas)
  prompts/agent-prompts.ts                          # instruções + guardrails compartilhados
  tools/trading-data.tools.ts                       # ferramentas SOMENTE LEITURA sobre os serviços existentes
  tools/tool-policy.ts                              # a barreira de segurança (só tools `read`)
  providers/openai-agents.runner.ts                 # único arquivo que usa o SDK (@openai/agents)
```

- **SDK**: `@openai/agents` (Agents SDK oficial para TypeScript) + `openai` + `zod` 4. Usa um `Runner` com
  cliente OpenAI próprio (chave, timeout e retries vindos do env), não as configurações globais do SDK.
  Tracing fica desligado por padrão (`OPENAI_TRACING_ENABLED`).
- **Agentes**: `performance-analyst`, `trade-reviewer`, `signal-explainer`, `risk-analyst`,
  `market-analyst`. Todos devolvem saída estruturada validada com zod: `summary`, `findings`,
  `recommendations[{action, rationale, requiresBacktest}]`, `confidence` e `dataUsed`.
- **Ferramentas** (todas leitura): status do bot, métricas, breakdown por lado/símbolo/estratégia, trades e
  sinais recentes, configuração da estratégia, snapshot de mercado (só dos símbolos configurados) e
  execuções de backtest.
- **Limites de segurança**: não existe caminho de código do agente até `ExecutionService`, ordens,
  pause/resume/kill switch ou escrita no Mongo. O `tool-policy` recusa qualquer tool que não seja `read`
  antes de qualquer chamada de rede. As recomendações são só dados, com `advisoryOnly: true`. Para
  adicionar ações no futuro, é preciso mudar essa política de propósito, passando por `ControlApiKeyGuard`
  e aprovação humana (`needsApproval` do SDK).
- **Endpoints**:
  - `GET /ai/status`.
  - `POST /ai/agents/:agent/run`, com body `{question?, symbol?, mode?, from?, to?}`. Exige
    `X-Control-Api-Key` e tem limite de 10 req/min.
  - Códigos de erro: 503 = desligado/sem chave, 504 = timeout, 502 = erro da OpenAI, 429 = excesso de
    execuções simultâneas.
- **Resiliência**:
  - timeout por request (`OPENAI_REQUEST_TIMEOUT_MS`) e da execução inteira (`OPENAI_AGENT_TIMEOUT_MS`,
    via AbortSignal);
  - retries do cliente em 429/5xx (`OPENAI_MAX_RETRIES`);
  - `OPENAI_AGENT_MAX_TURNS` e `OPENAI_MAX_CONCURRENT_RUNS`.
  - Nenhum módulo de trading depende do `AiModule`: se a OpenAI cair, só `/ai/*` falha.
- **Logs**: `[OpenAI] agent request started/completed/failed`, com duração, requests e tokens. Nunca
  registram a chave nem o texto da pergunta.

## Variáveis de ambiente adicionadas

| Variável | Obrigatória | Padrão | Descrição |
|---|---|---|---|
| `TREND_ALLOW_SHORT` | não | `false` | Liga as entradas Short (espelho das regras Long) |
| `DISCORD_ENABLED` | não | `false` | Liga o canal Discord |
| `DISCORD_WEBHOOK_URL` | sim, se `DISCORD_ENABLED=true` | — | URL do webhook (secreta) |
| `DISCORD_USERNAME` | não | `Trade Bot` | Nome exibido nas mensagens |
| `DISCORD_EVENTS` | não | `alerts,trades,reports,signals` | Categorias enviadas ao Discord |
| `TELEGRAM_ENABLED` | não | `true` | `false` desliga o Telegram mesmo com token/chat |
| `TELEGRAM_EVENTS` | não | `alerts` | Categorias enviadas ao Telegram |
| `NOTIFICATIONS_TIMEOUT_MS` | não | `5000` | Timeout por tentativa HTTP dos canais |
| `DAILY_REPORT_ENABLED` | não | `true` | Liga o resumo diário (categoria `reports`) |
| `DAILY_REPORT_HOUR` | não | `8` | Hora local (0–23, fuso `NOTIFICATIONS_TIME_ZONE`) do resumo diário |
| `SIGNAL_VETO_DIGEST_MINUTES` | não | `60` | Janela de agrupamento dos sinais vetados (0 = um por veto) |
| `REDIS_ENABLED` | não | `true` | `false` desliga o cache (equivale a `REDIS_URL=`) |
| `REDIS_COMMAND_TIMEOUT_MS` | não | `500` | Timeout por comando Redis |
| `REDIS_CONNECT_TIMEOUT_MS` | não | `2000` | Timeout de conexão |
| `REDIS_MAX_RECONNECT_ATTEMPTS` | não | `10` | Tentativas antes de desistir (depois, 1 re-probe a cada 5 min) |
| `OPENAI_AGENTS_ENABLED` | não | `false` | Liga a camada de AI |
| `OPENAI_API_KEY` | sim, se `OPENAI_AGENTS_ENABLED=true` | — | Chave da OpenAI (secreta) |
| `OPENAI_MODEL` | não | modelo padrão do SDK | Modelo usado pelos agentes |
| `OPENAI_REQUEST_TIMEOUT_MS` | não | `30000` | Timeout por request à OpenAI |
| `OPENAI_MAX_RETRIES` | não | `2` | Retries do cliente OpenAI (429/5xx) |
| `OPENAI_AGENT_TIMEOUT_MS` | não | `90000` | Timeout da execução inteira do agente |
| `OPENAI_AGENT_MAX_TURNS` | não | `8` | Máximo de turnos (chamadas de modelo) por execução |
| `OPENAI_MAX_CONCURRENT_RUNS` | não | `2` | Execuções simultâneas permitidas |
| `OPENAI_TRACING_ENABLED` | não | `false` | Envia traces ao dashboard da OpenAI (contém dados de trading) |

Já existentes, sem mudança de nome: `REDIS_URL`, `REPORTS_CACHE_TTL_SECONDS`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`.

## Por que não RabbitMQ (por enquanto)

Avaliamos e decidimos **não** adicionar um message broker agora. RabbitMQ resolve problemas que
este projeto não tem hoje: múltiplos serviços/instâncias independentes consumindo a mesma fila,
processamento assíncrono pesado desacoplado do request, ou workers horizontais. Aqui:

- A aplicação roda como **um único processo** (sem múltiplas réplicas do `ExecutionModule`
  concorrendo pela mesma fila).
- A comunicação entre módulos já é assíncrona **dentro do processo**, via
  `@nestjs/event-emitter` (`trade.opened`, `bot.paused`, `alert.critical`...) — resolve o mesmo
  problema de desacoplamento que uma fila resolveria, sem o custo operacional de outro serviço
  para subir, monitorar e manter disponível.
- O gatilho de execução já é por polling/`@Cron` (Fases 5 e 7), não por eventos externos que
  precisassem de uma fila para buffer/retry.

RabbitMQ passaria a fazer sentido se o projeto evoluir para **múltiplos workers** (ex.: um
processo rodando `ExecutionModule` por símbolo, escalado horizontalmente) ou para desacoplar de
verdade serviços diferentes (ex.: um serviço de notificações separado do backend principal). Até
lá, adicionar um broker só aumentaria a complexidade operacional (mais um serviço no Docker Compose,
mais um ponto de falha, mais configuração) sem resolver nenhum gargalo real.

## Modelagem MongoDB

✅ `trades`, ✅ `orders`, ✅ `signals`, ✅ `equity_snapshots`, ✅ `backtest_runs`, ✅ `funding_rates`, ✅ `bot_state`
— com índices em `trades(mode, status, symbol, entryTime)`, `orders(clientOrderId unique)`,
`signals(candleTime, strategy, symbol)`, `funding_rates(symbol, timestamp)`.

## Endpoints REST

- ✅ `GET /bot/status`, ✅ `POST /bot/pause`, ✅ `POST /bot/resume`, ✅ `POST /bot/kill-switch`
- ✅ `GET /trades`, ✅ `GET /trades/:id`, ✅ `GET /trades/export.csv`
- ✅ `GET /signals` (inclui rejeitados): paginado, mais novo primeiro, com filtros `mode`,
  `symbol`, `strategy`, `approved`, `runId` e `from`/`to` (sobre `candleTime`)
- ✅ `GET /reports/summary`, ✅ `/reports/equity-curve`, ✅ `/reports/by-strategy`, ✅ `/reports/by-symbol`,
  ✅ `/reports/by-hour`, ✅ `/reports/compare-modes`
- ✅ `POST /backtest/run`, ✅ `GET /backtest/runs`, ✅ `GET /backtest/runs/:runId`
- ✅ `GET /reports/by-side` (LONG vs SHORT); filtro `side` em `/reports/*` e `/trades`
- ✅ `GET /ai/status`, ✅ `POST /ai/agents/:agent/run` (análise, somente leitura)
- ✅ `GET /funding/ranking`
- ✅ `GET /exchange/balance`, ✅ `GET /market/candles` (hoje em `/exchange/candles`)
- ✅ `GET /events/stream` (SSE: nova trade, atualização de posição, alertas)

(✅ = já implementado; todos os endpoints do plano original existem.)

### Ajustes feitos para o painel (frontend/)

- `GET /bot/status` ganhou `lastPollAt` (heartbeat do loop, a cada tick), `executionEnabled` e
  `pollIntervalSeconds`. `lastCycleAt` só anda quando fecha um candle novo (de hora em hora no 1h),
  então não serve para detectar loop parado. `pauseReason` só vem quando `paused: true`.
- `POST /bot/resume` agora remove `pauseReason` (`$unset`). Antes o motivo antigo ficava gravado.
- `EquityRecorderService`: grava `equity_snapshots` de PAPER/LIVE a cada
  `EQUITY_SNAPSHOT_INTERVAL_MINUTES` (padrão 5), com equity = USDT (livre + travado) + posições
  abertas pelo último close de 1m. Só roda com `EXECUTION_ENABLED=true`. Antes, só o backtest
  gravava snapshots.
- `GET /reports/equity-curve` aceita `from`/`to` (sobre `timestamp`), validados por DTO.
- `/reports/*` aceita `dateField=entryTime|exitTime` (padrão `entryTime`). O painel usa `exitTime`
  para o "PnL do dia".
- `GET /trades` (e `export.csv`) aceita `isSeed=true|false` e `runId`. Trades reais não têm o
  campo `isSeed`.
- `/reports/*` aceita `runId`, que filtra as trades de uma execução de backtest.
- `GET /reports/by-hour` aceita `tz` (fuso IANA, padrão UTC). As faixas de hora e de dia da semana
  são calculadas pela hora de saída nesse fuso, e a resposta traz `timezone`. As chaves vêm em
  ordem numérica (antes vinham em ordem de texto: "10" antes de "2"). Fuso inválido → 400.
- **Mudou o formato de `GET /reports/compare-modes`**: agora retorna sempre três itens,
  `{ mode, runId, summary }`, com o `MetricsSummary` completo de BACKTEST, PAPER e LIVE. `runId`
  escolhe a execução de backtest (sem ele, entram todas). `from`/`to`/`dateField` valem só para
  PAPER e LIVE, porque as datas do backtest são históricas.
- `MetricsSummary` ganhou `avgReturnPct` (média do `pnlPct` por trade), que não depende do tamanho
  da posição. É a base de comparação entre modos. Execuções antigas salvas não têm o campo.
- **`GET /strategies`** (novo): estratégias registradas, com seus parâmetros ajustáveis (`key`,
  `description`, `min`, `max`, `integer` e o `value` atual vindo do env). Também informa o que o
  loop paper/live roda (`live: { strategy, symbols, timeframe, regimeTimeframe }`). Não expõe
  segredos.
- `POST /backtest/run` aceita `strategyParams` (ex.: `{ "emaFast": 10 }`).
  - Os valores são validados contra o spec da estratégia; parâmetro inválido ou `from >= to`
    devolvem 400.
  - O backtest usa uma **cópia** da estratégia (`withParams`); a instância do loop ao vivo nunca
    é alterada.
  - Os parâmetros efetivos (defaults + overrides) entram no `paramsHash`, então cada combinação
    diferente conta como mais uma variação testada.
- `GET /backtest/runs` e `/backtest/runs/:runId` trazem `paramVariationsTestedForStrategy`
  (quantidade de `paramsHash` distintos da estratégia). O painel usa isso para o aviso de overfitting.
- `GET /backtest/runs` é paginado: `?strategy=&page=1&limit=20` (máx. 200) → `{ items, total, page, limit }`.
- Cada execução grava `benchmark` (comprar e segurar: preço inicial/final e retorno por símbolo, e a
  média com alocação igual em `buyAndHoldPct`) e `costs` (`totalFees`, `feesPctOfCapital`).
  Execuções antigas não têm esses campos; o painel mostra "—".
- `BacktestRun` com `minimize: false`: o Mongoose apagava objetos vazios ao salvar, então uma
  execução sem trades perdia `summary.exitReasonBreakdown`.
- **Backtest com a mesma visão de mercado do loop ao vivo:**
  - **Regime:** a EMA de regime usa `regimeTimeframe` (padrão `TREND_REGIME_TIMEFRAME`, 4h), com
    só os candles de regime já fechados naquele ponto (sem lookahead). Antes era calculada no
    timeframe do próprio backtest.
  - **Janela:** cada passo vê `emaRegime + 10` candles, a mesma quantidade que o loop busca.
  - **Aquecimento:** o histórico antes de `from` é carregado para os indicadores (`tradeFrom`),
    mas não é negociado nem entra na curva.
  - **Taxa:** a taxa de entrada era cobrada duas vezes no saldo e na curva de equity (o PnL das
    trades estava certo). Corrigido: saldo final = inicial + soma do PnL.
- **Backtest com vários símbolos** (`symbols`, até 10; `symbol` continua aceito). O saldo inicial
  é dividido igualmente e cada símbolo é simulado sozinho (alocação fixa, sem margem
  compartilhada). A curva da execução é a soma das curvas. No walk-forward, o saldo de cada
  símbolo passa de uma janela para a seguinte.
- `backtest.completed` (evento): invalida o cache de relatórios, porque as trades de backtest
  entram em lote, sem eventos `trade.*`, e aparece no stream.
- **`GET /health`** (novo): MongoDB (obrigatório) e Redis (cache fail-open), com latência.
- **Histórico de eventos:**
  - Cada evento do stream também é gravado em `bot_events`, com TTL de 30 dias, e ganha um `id`
    (o mesmo no SSE e no histórico).
  - `GET /events/recent?limit=&before=` devolve esse histórico.
  - **Evento novo:** `bot.cycle` (HOLD/ENTER/EXIT/SKIP de cada candle fechado, com o motivo).
  - `bot.cycle` e `bot.error` levam o `mode`.
- **Carteira PAPER persistida** (`paper_balances`): carregada no primeiro uso e salva a cada fill.
  Um restart não zera mais o saldo enquanto as trades abertas continuam no Mongo. Para zerar o
  paper, apague o documento `paper` dessa coleção.
- **Redis, validado** (`redis-cache.service.integration.spec.ts`, roda contra o Redis real se
  estiver acessível):
  - cacheia com TTL, serve do cache, expira e invalida por prefixo via SCAN;
  - com o Redis fora, vira cache miss sem erro (fail-open).
  - Até a conexão ficar pronta (por exemplo, logo após o boot), os comandos são cache miss de
    propósito (`enableOfflineQueue: false`).
  - O shutdown não trava mais com o Redis fora do ar: `disconnect()` quando não conectado.
- **`GET /signals`** (novo). No paper/live, a coleção `signals` guarda **um registro por sinal
  de entrada avaliado pelo risco** (aprovado ou vetado, com `rejectReason`). Sinais HOLD e saídas
  não são gravados; o último por símbolo fica em `/bot/status`. Os registros passaram a guardar
  também `reason` (a explicação da estratégia) e `price`.
- **SSE, eventos novos:**
  - `signal.recorded`: entrada avaliada pelo risco, com `approved` e `rejectReason`.
  - `bot.error`: erro do loop, emitido só quando a mensagem muda ou 10 min depois do último,
    para não inundar o stream.
- **`GET /funding/ranking`** passou a ler só o **último scan** (match pelo `timestamp`
  indexado), em vez de ordenar e agrupar o histórico inteiro, que cresce cerca de 12 mil
  documentos por dia. Aceita `search` (trecho do símbolo) e `order`:
  - `desc`: maiores taxas;
  - `asc`: menores e negativas, que antes nunca apareciam no top 200;
  - `abs`: maior magnitude.
- `GET /exchange/candles` aceita `startTime`/`endTime` (epoch ms, sobre o `openTime`), repassados
  ao `klines` da Binance. O detalhe da trade usa isso para buscar os candles do período dela.
- `GET /events/stream` manda um evento `ping` a cada 25 s, para a conexão ociosa não ser derrubada
  por proxies (o `fetch` do Node corta um corpo sem dados após 5 min).

## Roadmap por fases (detalhado)

- ✅ **Fase 1 — Scaffold**: config validada, Docker Compose, conexão Mongo, `ExchangeGateway`
  (Binance testnet + Paper), leitura de saldo e candles.
- ✅ **Fase 2 — Trades**: schemas Mongoose, `TradesModule` e endpoints de consulta, com seed de
  dados fake para o painel.
- ✅ **Fase 3 — Estratégia e Risco**: indicadores, `TrendRegimeStrategy` e `RiskManager`, com testes.
- ✅ **Fase 4 — Backtest e Relatórios**: backtest engine, walk-forward e métricas em `ReportsModule`.
- ✅ **Fase 5 — Execução**: `ExecutionModule` em modo PAPER e testnet, com stop na exchange,
  reconciliação e User Data Stream.
- ✅ **Fase 6 — Controle**: kill switch, limites diários (auto-pausa), notificações e SSE.
- ✅ **Fase 7 — Funding**: scanner de funding rate (somente leitura).
- Autenticação do painel (API key/JWT) entra quando os endpoints do painel existirem — hoje só o
  `ControlModule` (pause/resume/kill-switch) tem uma checagem de API key própria, opcional
  (`CONTROL_API_KEY`), por ser o único grupo de endpoints que pode mexer em ordens reais.

Todas as 7 fases planejadas estão implementadas. O que fica de fora deste projeto por enquanto:
autenticação de painel para os demais endpoints (trades/reports/backtest ainda são públicos),
pairlist dinâmica por volume/liquidez (hoje os símbolos são uma lista fixa via `TREND_SYMBOLS`,
sem filtro automático de tokens alavancados como `*UP`/`*DOWN`), otimização automática de
parâmetros por grid-search no walk-forward, simulação de taxas em `PAPER`/`LIVE` (só o backtest
aplica `feesPct`), e a verificação ao vivo dos caminhos específicos de `LIVE`/testnet do
`ExecutionModule` (ver aviso na seção da Fase 5) — tudo isso está documentado inline no código
onde relevante.

### Fase 1 — detalhes do que foi feito

- Scaffold NestJS (TypeScript strict, pnpm, Jest).
- Validação de config com Joi via `@nestjs/config`: falha rápido na inicialização se o modo
  `LIVE` não estiver total e explicitamente confirmado, ou se faltarem chaves da Binance quando
  exigidas.
- Docker Compose: serviços `app` + `mongo`.
- Conexão Mongoose via `DatabaseModule`.
- Interface `ExchangeGateway` + `BinanceExchangeGateway` (testnet, saldo/candles/ordens reais)
  + `PaperExchangeGateway` (saldo/ordens simulados, dados de mercado reais).
- `GET /exchange/balance` e `GET /exchange/candles` para verificar manualmente os dois gateways.
- Logs estruturados via `nestjs-pino`, `ValidationPipe` global, Swagger em `/docs`, rate limiting
  básico (`@nestjs/throttler`).

#### Como testar a Fase 1

```powershell
docker compose up mongo -d
pnpm run start:dev
# em outro terminal
curl http://localhost:8000/
curl http://localhost:8000/exchange/balance
curl "http://localhost:8000/exchange/candles?symbol=BTCUSDT&interval=1h&limit=10"
```

Com o `.env` padrão (`TRADING_MODE=PAPER`), `/exchange/balance` retorna o
`PAPER_INITIAL_BALANCE_AMOUNT` simulado e `/exchange/candles` retorna candles reais da testnet.

### Fase 2 — detalhes do que foi feito

- Schemas Mongoose `Trade` e `Order` ([src/trades/schemas](../src/trades/schemas)), com os campos
  do plano original e os índices (`trades(mode,status,symbol,entryTime)`,
  `orders.clientOrderId` único).
- `TradesModule`: `GET /trades` (filtros `mode`/`symbol`/`strategy`/`status`/`from`/`to`,
  paginação e ordenação), `GET /trades/:id` (404 se não existir), `GET /trades/export.csv`.
- Seed de dados fake para o painel: `pnpm run seed` gera 60 trades plausíveis (BTCUSDT/ETHUSDT,
  mistura de PAPER/BACKTEST, abertas/fechadas, PnL calculado) — é um script, não um endpoint HTTP,
  para não correr o risco de popular dados fake sem querer em produção.
- Os schemas de `signals`, `equity_snapshots`, `backtest_runs`, `funding_rates` e `bot_state` ficam
  para as fases que realmente os utilizam (3, 4, 6 e 7), em vez de criá-los sem uso agora.

#### Como testar a Fase 2

```powershell
docker compose up mongo -d
pnpm run seed
pnpm run start:dev
# em outro terminal
curl "http://localhost:8000/trades?limit=5"
curl "http://localhost:8000/trades?status=OPEN"
curl "http://localhost:8000/trades/export.csv"
```

### Fase 3 — detalhes do que foi feito

- `IndicatorsService` ([src/indicators](../src/indicators)): EMA, RSI e ATR via `technicalindicators`,
  com os resultados alinhados ao mesmo tamanho/índice dos candles de entrada (preenchendo o
  período de aquecimento com `undefined`).
- Interface `Strategy` ([src/strategy/strategy.interface.ts](../src/strategy/strategy.interface.ts)):
  pura, sem chamadas à exchange ou ao banco — `onCandleClosed(ctx)` recebe só candles já
  fechados e devolve um `Signal`. `StrategyRegistryService` permite registrar/consultar
  estratégias por nome (pronto para Grid/DCA no futuro).
- `TrendRegimeStrategy`: filtro de regime (EMA200 no timeframe maior), entrada por cruzamento
  EMA20/EMA50 + RSI(14) em faixa, stop por ATR, saída por cruzamento contrário das EMAs **ou**
  chandelier exit. Todos os parâmetros vêm de env (`TREND_*`, ver
  [.env.example](../.env.example)).
- `RiskManagerService` ([src/risk](../src/risk)): função síncrona e pura `evaluate(signal, ctx)` —
  aplica todos os vetos do plano (bot pausado, reconciliação falhou, perda diária, stops
  seguidos, máximo de posições, sem stop, R:R mínimo, liquidez/spread), calcula o tamanho da
  posição (`risco% × equity / distância do stop`), limita pela exposição máxima por
  ativo/total, e arredonda pela `LOT_SIZE`/`MIN_NOTIONAL` da Binance.
- `order-rounding.util.ts` ([src/exchange](../src/exchange)): arredondamento de quantidade/preço
  pelos filtros da Binance, sem os erros clássicos de ponto flutuante (`0.1 * 1000 ≠ 100` em JS).
- Schema `signals` + `SignalsService` (persistência) já existem, mas ainda não são chamados por
  nada nesta fase — passam a ser usados de verdade na Fase 5 (`ExecutionModule`).
- **Sem endpoints novos nesta fase**: como ainda não há um loop de execução em tempo real
  (isso é Fase 5), a verificação é feita por testes automatizados, não por chamadas manuais.

#### Como testar a Fase 3

```powershell
pnpm test -- --testPathPattern "indicators|order-rounding|strategy|risk"
```

Os testes cobrem: cada função de indicador, arredondamento por filtros, cada regra de veto do
`RiskManager`, a lógica da estratégia com candles fixos (entrada, bloqueio por RSI/regime, saída
por cruzamento de EMA), e uma prova de que a estratégia rejeita candles ainda não fechados
(sem lookahead).

### Fase 4 — detalhes do que foi feito

- **`market-data/`** (novo módulo): `HistoricalCandlesService` baixa klines históricos da Binance
  com paginação (1000 candles por página) e guarda em cache no Mongo (`market_candles`, único por
  `symbol+interval+openTime`) — reduz chamadas repetidas de rede para o mesmo intervalo.
- **`BacktestRunner`** ([src/backtest/backtest-runner.ts](../src/backtest/backtest-runner.ts)): motor
  de simulação **puro** (sem I/O) que roda candle a candle, usando a mesma `Strategy` e o mesmo
  `RiskManagerService` do paper/live — só a "exchange" é simulada aqui. Aplica fees/slippage
  configuráveis, a hipótese conservadora de stop-antes-do-alvo no mesmo candle, e alimenta o
  `RiskManager` com `dailyPnl`/`consecutiveStopLosses` reais (os limites de risco valem de verdade
  no backtest, não são ignorados).
- **Walk-forward (v1 simplificado)**: `POST /backtest/run` aceita `walkForward.testWindowDays` e
  divide o período em janelas sequenciais, rodando cada uma de forma independente e reportando um
  resultado por janela. **Não** faz otimização automática de parâmetros por grid-search na janela
  de "otimização" ainda — isso fica para uma iteração futura.
- `computeParamsHash` (hash das configs) + contagem de `paramsHash` distintos por estratégia em
  `backtest_runs`, devolvida em `paramVariationsTestedForStrategy` — lembrete de risco de overfitting.
- Cada corrida grava `trades` (mode `BACKTEST`, com `runId`), `signals` (aprovados/vetados) e
  `equity_snapshots`, exatamente como paper/live vão gravar futuramente.
- **`ReportsModule`**: `metrics.util.ts` calcula PnL, win rate, payoff, profit factor, expectância,
  max drawdown, Sharpe/Sortino (por trade, não por dia — simplificação documentada), maior sequência
  de perdas, tempo médio em posição, histograma de PnL% e distribuição por motivo de saída.
  `by-strategy`/`by-symbol`/`by-hour`/`compare-modes` usam aggregation pipelines do Mongo
  (`$group`/`$facet`) com paginação.

#### Como testar a Fase 4

```powershell
docker compose up mongo -d
pnpm run seed
pnpm run start:dev
# em outro terminal
curl "http://localhost:8000/reports/summary"
curl "http://localhost:8000/reports/by-strategy"
curl "http://localhost:8000/reports/by-symbol"
curl "http://localhost:8000/reports/compare-modes"

# Backtest real (precisa de acesso de rede à Binance; POST com corpo JSON via Swagger em /docs
# é o jeito mais fácil de testar manualmente)
curl -X POST "http://localhost:8000/backtest/run" -H "Content-Type: application/json" -d "{\"strategy\":\"TrendRegimeStrategy\",\"symbol\":\"BTCUSDT\",\"timeframe\":\"1h\",\"from\":\"2026-06-01T00:00:00Z\",\"to\":\"2026-09-01T00:00:00Z\"}"
```

Testado localmente: `/reports/*` funcionam de ponta a ponta contra o Mongo real (dados do seed da
Fase 2). O `POST /backtest/run` chega corretamente até a Binance para baixar candles, mas em redes
que bloqueiam a API da Binance (como o sandbox usado no desenvolvimento) a chamada externa falha —
não é um bug do código, é a mesma restrição de rede já vista na Fase 1.

### Fase 5 — detalhes do que foi feito

- **`ExecutionModule` desligado por padrão**: mesmo em `PAPER`, o loop automático só liga com
  `EXECUTION_ENABLED=true` — mais uma camada explícita de opt-in além do `TRADING_MODE`, para não
  rodar nada sozinho sem querer durante desenvolvimento normal.
- **Gatilho por polling, não WebSocket de candles**: em vez de um stream de klines em tempo real,
  um poller (`MarketPollerService`, intervalo configurável via `EXECUTION_POLL_INTERVAL_SECONDS`)
  busca o último candle fechado de cada símbolo configurado e dispara o ciclo
  sinal → risco → execução só quando detecta um candle novo (com deduplicação por símbolo+modo).
  **Simplificação deliberada**: para os timeframes da estratégia (1h/4h), alguns segundos de atraso
  após o fechamento do candle são irrelevantes; um stream de klines de verdade pode substituir o
  poller depois sem tocar no `ExecutionService`.
- **`ExecutionService`**: reproduz a mesma ordem de decisão do backtest (verifica stop/saída da
  posição aberta usando o candle atual **antes** de considerar uma nova entrada), usando a mesma
  `Strategy` e o mesmo `RiskManagerService`. Em `PAPER`, o "stop" é conferido localmente a cada
  ciclo (mesma regra conservadora do backtest: se o candle toca stop e alvo, assume-se o stop).
  Em `LIVE`/testnet, o stop é uma ordem `STOP_LOSS_LIMIT` real na exchange — **se a criação dessa
  ordem falhar, a posição é fechada a mercado imediatamente e um alerta `CRITICAL` é logado**
  (nunca fica posição sem proteção).
- **`newClientOrderId` determinístico** (hash de modo+símbolo+candleTime+propósito) — protege
  contra ordens duplicadas em retry/reconexão.
- **`ReconciliationService`**: em `PAPER` sempre reporta saudável (nada real para sincronizar). Em
  `LIVE`, roda na inicialização e a cada `EXECUTION_RECONCILIATION_INTERVAL_MINUTES`, compara
  ordens locais pendentes contra as abertas na exchange, atualiza o status real de quem sumiu da
  lista (preenchida, cancelada...), fecha o trade correspondente se o stop foi preenchido, e força
  fechamento a mercado se um stop desaparecer sem preencher. O resultado alimenta
  `RiskContext.reconciliationOk`, bloqueando novas entradas se a reconciliação falhar.
- **`UserDataStreamService`**: conecta ao User Data Stream privado da Binance (só quando
  `gateway.kind === 'BINANCE'`), com keepalive do `listenKey` a cada 30 min e reconexão com
  backoff exponencial. Em v1, só loga as atualizações de ordem como um "aviso rápido" — quem
  fecha trades de fato é o `ReconciliationService`, evitando corrida entre os dois caminhos.
- **Simplificações conhecidas** (documentadas no código): sem simulação de taxas em `PAPER`/`LIVE`
  (só o backtest aplica `feesPct`), sem OCO combinado (só stop-limit simples, já que a estratégia
  atual não usa take-profit fixo).

> ⚠️ **Limite de verificação**: `ExecutionService` em modo PAPER foi testado com testes unitários
> completos (entrada, veto do risco, saída por stop intra-candle, deduplicação de candle). Já os
> caminhos específicos de `LIVE`/testnet — ordem `STOP_LOSS_LIMIT` real, `ReconciliationService`
> contra a exchange, e `UserDataStreamService` — foram implementados seguindo a documentação da
> Binance, mas **não puderam ser testados contra uma conexão real** neste ambiente de
> desenvolvimento (a mesma restrição de rede HTTP 451 das fases anteriores). Teste em testnet
> você mesmo antes de confiar neles com ordens de verdade.

#### Como testar a Fase 5

```powershell
docker compose up mongo -d
# no .env: EXECUTION_ENABLED=true (mantém TRADING_MODE=PAPER)
pnpm run start:dev
```

Nos logs você deve ver `MarketPollerService` anunciando o loop ligado e tentando um ciclo por
símbolo a cada `EXECUTION_POLL_INTERVAL_SECONDS`. Sem acesso à Binance a partir da sua rede, o
ciclo falha graciosamente (log de erro, sem derrubar o app); com acesso, ele deve abrir/fechar
posições reais em `trades` conforme a `TrendRegimeStrategy` decide.

### Fase 6 — detalhes do que foi feito

- **`ControlModule`** ([src/control](../src/control)): `bot_state` é um documento singleton
  (pausado/ativo, motivo, última reconciliação). `RiskContextBuilderService` agora lê o estado
  real de pausa em vez do `false` fixo da Fase 5 — pausar bloqueia novas entradas de verdade.
  - `GET /bot/status` — aberto, sem autenticação.
  - `POST /bot/pause`, `POST /bot/resume`, `POST /bot/kill-switch` — protegidos por
    `ControlApiKeyGuard`: se `CONTROL_API_KEY` estiver configurada, exige o header
    `X-Control-Api-Key`; se não estiver (padrão local), passa livre (mesma postura do resto do
    projeto, que ainda não tem autenticação de painel).
  - **Kill switch**: cancela todas as ordens abertas na exchange, fecha a mercado todas as
    posições abertas do modo atual, e pausa o bot. Cada cancelamento/fechamento é tentado
    individualmente (uma falha não impede as demais) e o resultado retorna quantos de fato
    foram cancelados/fechados.
- **Auto-pausa por limite diário/stops seguidos**: depois de qualquer trade fechado,
  `ExecutionService` recalcula `dailyPnl`/`consecutiveStopLosses` e chama
  `ControlService.checkAutoPauseConditions(...)` — se `RISK_MAX_DAILY_LOSS_PCT` ou
  `RISK_MAX_CONSECUTIVE_STOPS` foram estourados, o bot pausa sozinho (não é mais só um veto
  pontual do `RiskManager`, vira um estado persistido até alguém retomar manualmente).
- **Eventos de domínio** via `@nestjs/event-emitter` (`trade.opened`, `trade.closed`,
  `bot.paused`, `bot.resumed`, `alert.critical`), emitidos por `ExecutionService`,
  `ReconciliationService` e `ControlService` — desacopla quem decide algo de quem reage a isso.
- **`NotificationsModule`** ([src/notifications](../src/notifications)): `TelegramNotifierService`
  escuta `alert.critical`/`bot.paused` e envia para o Telegram se `TELEGRAM_BOT_TOKEN`/
  `TELEGRAM_CHAT_ID` estiverem configurados; sempre loga localmente também, então nada se perde
  silenciosamente se o Telegram não estiver configurado.
- **`EventsModule`** ([src/events](../src/events)): `GET /events/stream` (Server-Sent Events) —
  escuta os mesmos eventos de domínio e transmite para o painel em tempo real (nova trade,
  atualização de posição, alertas). Testado manualmente: `curl` confirma
  `Content-Type: text/event-stream`.

#### Como testar a Fase 6

```powershell
docker compose up mongo -d
pnpm run start:dev
# em outro terminal
curl http://localhost:8000/bot/status
curl -X POST http://localhost:8000/bot/pause -H "Content-Type: application/json" -d '{"reason":"teste"}'
curl -X POST http://localhost:8000/bot/resume
curl -X POST http://localhost:8000/bot/kill-switch
curl -i --max-time 2 http://localhost:8000/events/stream
```

Testado localmente de ponta a ponta: pause/resume/status funcionam, o kill switch encontrou
trades abertas reais (do seed da Fase 2) e tentou fechá-las corretamente (falhou só na chamada de
rede para a Binance, o mesmo limite de sempre neste ambiente), e o SSE responde com o
content-type correto.

### Fase 7 — detalhes do que foi feito

- **`FundingService`** ([src/funding](../src/funding)): consulta `GET /fapi/v1/premiumIndex` da API
  de Futuros da Binance (público, sem chave) a cada hora (`@Cron(CronExpression.EVERY_HOUR)` —
  primeira vez que `@nestjs/schedule`, instalado desde a Fase 1, é realmente usado) e também uma
  vez na inicialização. Grava uma linha por símbolo em `funding_rates` a cada scan (histórico
  append-only, nunca sobrescreve).
- **100% somente leitura**: `FundingService` não importa `ExchangeGateway` nem qualquer coisa que
  possa enviar ordens — usa um cliente HTTP próprio e minúsculo (`FundingRateClient`, via `fetch`
  nativo do Node) porque o `@binance/connector` não cobre a API de Futuros.
- **`GET /funding/ranking?limit=20`**: agregação Mongo pega a taxa mais recente por símbolo e
  ordena pela taxa anualizada (`rate × 3 × 365 × 100`, já que o funding dos perpétuos da Binance
  liquida a cada 8h).
- Falhas de rede no scan são capturadas e logadas — nunca derrubam a aplicação (mesmo padrão
  usado em todo o resto do projeto).

#### Como testar a Fase 7

```powershell
docker compose up mongo -d
pnpm run start:dev
# em outro terminal
curl "http://localhost:8000/funding/ranking?limit=10"
```

Testado localmente: a rota mapeia corretamente, o scan roda na inicialização e por `@Cron`, e o
endpoint responde `[]` graciosamente quando não há dados (ou quando o scan falha por causa da
mesma restrição de rede HTTP 451 deste ambiente de desenvolvimento).

## Testes

- ✅ Unitários: indicadores, cálculo de tamanho de posição, arredondamento por filtros da Binance,
  `RiskManager` (cada regra de veto), lógica da estratégia com candles fixos, métricas.
- ✅ Teste do backtest engine com dataset pequeno e resultado esperado calculado à mão.
- ⏳ Testes de integração com `mongodb-memory-server` (ainda usando Mongo real via Docker nos testes
  manuais; `mongodb-memory-server` como dependência de teste fica para quando os testes automatizados
  precisarem de banco, hoje todos os specs são unitários/puros).
- ✅ Teste que prova que a estratégia não usa o candle em formação (sem lookahead).
- ✅ Long/Short: PnL dos dois lados (inclusive simetria exata), stop/take profit intra-candle por lado,
  entradas/saídas Short na estratégia, sizing e vetos do risco (`SHORT_NOT_SUPPORTED`, stop/TP do lado
  errado), execução PAPER (SELL/BUY), stop-limit LIVE do short, kill switch, carteira paper, equity e backtest
  (carry e slippage do short).
- ✅ Notificações: envio, erro 5xx com retry, timeout sem retry, 429, webhook 404, canal desabilitado,
  isolamento entre canais e ausência de segredos nos logs.
- ✅ Redis: desabilitado, Redis "travado" (servidor RESP falso), fallback, backoff/desistência e erros reais
  não mascarados.
- ✅ OpenAI: configuração válida/ausente, desabilitado, erro 401 e timeout **passando pelo SDK real** com
  `fetch` falso, saída estruturada, limite de concorrência e política de ferramentas.

## Licença

Nest is [MIT licensed](https://github.com/nestjs/nest/blob/master/LICENSE).
