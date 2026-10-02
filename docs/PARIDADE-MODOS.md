# Paridade entre PAPER, LIVE e BACKTEST

O backtest usa a mesma `Strategy` e o mesmo `RiskManager` do loop de paper/live. Só o "mercado" e a
conta mudam. Este documento lista **todas** as diferenças que podem fazer o paper divergir do que o
backtest mediu, e diz quais são intencionais.

## Corrigido nesta rodada

| Diferença | Antes | Agora |
|---|---|---|
| **Janela de candles da estratégia** | O live pedia `EMA200 + 10 + 2` klines e descartava só o candle em formação, então via **211** candles fechados (1h e 4h). O backtest via **210** e a ferramenta de IA via **221**. Como a EMA é semeada pela média dos primeiros 200 valores da janela, a EMA200 do regime era diferente nos três. Em 21 meses de BTC+ETH isso mudou de 1 a 5 trades. | Uma fonte única, `strategyWindowSize()` + `lastClosedCandles()` em `src/strategy/strategy-window.ts`: **210** candles fechados no live, no backtest, na ferramenta de IA e no ledger de candidatos. O 210 é a janela com que o backtest e a pesquisa V0–V3 foram validados. **Muda levemente o paper** (passa a decidir igual ao backtest). |
| **Short no PAPER** | O gateway de paper anunciava `supportsShortSelling = true`, então o PAPER fazia shorts que o LIVE (Binance Spot) nunca poderia fazer (`SHORT_NOT_SUPPORTED`). | O PAPER espelha o LIVE por padrão: short é vetado com `SHORT_NOT_SUPPORTED`. `PAPER_SIMULATED_SHORTS=true` volta a simular (pesquisa). Os shorts vetados continuam no ledger de candidatos, com o resultado sombra. **Muda o paper se `TREND_ALLOW_SHORT=true`.** |
| `entryTime` da posição aberta | O live não passava `entryTime` para a estratégia (o backtest passa). | Passa nos dois. Só o trailing desde a entrada (`trailingMode=1`, travado em 0 no paper/live) lê o campo, então nada muda hoje. |

## Diferenças intencionais (mantidas e documentadas)

| Tema | PAPER / LIVE | BACKTEST | Por quê |
|---|---|---|---|
| **Pausa por 3 stops seguidos** | Pausa o bot inteiro (`bot_state.isPaused`) até `POST /bot/resume`. O resume zera a sequência (`stopStreakResetAt`). | A sequência veta entradas (`CONSECUTIVE_STOPS_LIMIT`) até o próximo dia UTC (`stopPauses`). Ninguém retoma uma simulação. | É a proteção de segurança do bot: **não foi alterada**. Mas o backtest é otimista sobre quanto tempo o bot fica parado. O impacto real agora é medido: `pause_episodes`, `GET /bot/pauses` e `GET /candidates/pauses`. |
| **Perda diária de 3%** | Pausa até o resume manual. | Veta entradas (`DAILY_LOSS_LIMIT`) até o dia UTC seguinte, sem pausa. | Idem. |
| Equity usada no sizing | Saldo livre em USDT menos 2× o nocional dos shorts abertos (com um long aberto, sobra menos caixa, então a próxima entrada fica menor). | Saldo de caixa da simulação (o nocional do long não sai do caixa). | Mudar isso aumentaria o tamanho das posições no live. Fica como está; o backtest é levemente maior no sizing de posições simultâneas. |
| Risco agregado no mesmo lado (`maxSameSideRiskPct`) | Não existe. | Só com `portfolioMode` + o parâmetro (E4). | Experimento ainda não aprovado. |
| Preenchimento | Paper: ordem a mercado no último fechamento. Live: preço real da Binance. Stop real na exchange (live) ou checado dentro do candle (paper). | Fechamento + slippage. Stop dentro do candle, com gap preenchendo na abertura. | Modelo conservador. |
| Candles perdidos com o worker fora | Não são operados retroativamente (só o último candle é avaliado). No paper, os stops desses candles são checados. | Todo candle é avaliado. | Não dá para entrar no passado. Os gaps são registrados (`worker.gap`). |
| Short | LIVE: nunca (Spot). PAPER: só com `PAPER_SIMULATED_SHORTS=true`. | Sempre possível; quem decide é `allowShort`. | Pesquisa. |

## Regras que nunca disparam hoje (não são diferenças, mas confundem a leitura)

- `RR_TOO_LOW`: a estratégia não define take profit.
- `LOW_LIQUIDITY` / `SPREAD_TOO_WIDE`: `symbolLiquidity` nunca é preenchido.
- `MAX_OPEN_POSITIONS = 3` com 2 símbolos.

## Como verificar

- Janela: `src/candidates/candidate-features.spec.ts` (estratégia, feature builder e snapshot da IA dão
  os mesmos valores na mesma janela; `lastClosedCandles` com e sem o candle em formação).
- Short no paper: `src/exchange/paper/paper-exchange.gateway.spec.ts`.
- Pausa: `src/control/control.service.spec.ts` (episódios, duração, pausa dentro de pausa, pausa que funciona mesmo se o registro falhar).
