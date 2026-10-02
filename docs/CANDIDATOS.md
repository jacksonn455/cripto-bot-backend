# Ledger de candidatos, resultado sombra e juiz (fundação)

Objetivo: responder "quantas oportunidades existiram, por que cada uma foi descartada e o que teria
acontecido se tivesse sido operada", e preparar a avaliação offline de um juiz (determinístico hoje,
IA no futuro). **Nada aqui altera decisões de trading.** Com `AI_JUDGE_MODE=off` (padrão), o
comportamento é idêntico ao de antes. Isso é provado por testes e pela regressão de backtest.

## O que é um candidato

Toda vez que o **gatilho** de um setup dispara num candle fechado, sem posição aberta no símbolo:
- `EMA_CROSS`: cruzamento EMA rápida/lenta, para cima (LONG) ou para baixo (SHORT);
- `PULLBACK`: retomada após pullback (só com `pullbackLookback > 0`, desligado em produção).

A própria estratégia informa os candidatos (`Signal.candidates`), com o resultado de **todos** os gates.
Eles são avaliados sem curto-circuito e na ordem do funil:

```
Candles → Candidato (gatilho) → SIDE → REGIME → RSI → ADX* → INDICATORS → [aceito pela estratégia]
        → PAUSE (BOT_PAUSED, 1ª checagem do RiskManager) → RISK (demais vetos) → EXECUTION → ENTERED
* ADX só aparece com adxMin > 0.
```

`rejectedAt` é o primeiro estágio que reprovou (null = entrou). As decisões não leem esse campo.
Um teste garante que `accepted` coincide exatamente com a entrada emitida.

## Identidade

- `candidateId = mode:symbol:timeframe:candleClose:setupType:side`, por exemplo
  `PAPER:BTCUSDT:1h:1759276799999:EMA_CROSS:LONG`.
- `opportunityId` = o mesmo sem o modo: une a mesma oportunidade entre PAPER, LIVE, cada backtest e a
  análise sombra.
- Nunca aleatório. No paper/live, reavaliar o mesmo candle sobrescreve a linha. No backtest a chave
  inclui o `runId`.

## Coleção `candidate_assessments`

Por candidato:
- identidade e setup: `side`, `setupType`, `strategy`, `price` (fechamento), `stopLoss`;
- funil: `gates`, `strategyDecision`, `strategyRejectedAt`, `rejectedAt`, `finalAction`
  (`ENTERED | REJECTED | ENTRY_FAILED`);
- `features` (abaixo);
- `risk`: só para candidatos aceitos pela estratégia;
- `botPaused` e `pauseReason`;
- `riskIfResumed`: só quando a pausa vetou. É o RiskManager reexecutado, sem efeito, como se alguém
  tivesse feito `POST /bot/resume` naquele instante (pausa desligada, sequência de stops zerada,
  PnL do dia mantido). Responde "esse trade teria sido feito se o bot não estivesse pausado?";
- `assessment`: só em `AI_JUDGE_MODE=shadow`;
- `shadow`: o resultado sombra.

### Features (`buildCandidateFeatures`, `src/candidates/candidate-features.ts`)

É uma função pura, a mesma no live, no backtest, na ferramenta de IA e num juiz futuro. Usa só
indicadores que a estratégia já usa:
- valores brutos: EMA rápida e lenta, RSI, ATR, ADX (no timeframe do regime), EMA200 do regime;
- normalizados: ATR/preço, (EMA rápida − EMA lenta)/ATR, (preço − EMA rápida)/ATR, retornos de 1 e
  24 candles, distância ao EMA200 e o estado do regime (com a banda).

Volume e volatilidade realizada ficaram de fora de propósito: seriam indicadores novos. Tem que receber
**a mesma janela** que a estratégia viu (210 candles, ver [PARIDADE-MODOS.md](PARIDADE-MODOS.md)).

## Resultado sombra

`simulateShadowOutcome` (`src/candidates/shadow-outcome.ts`) faz o seguinte:
- entrada hipotética no fechamento do candidato, com slippage;
- o stop da própria estratégia;
- as saídas pelo **mesmo passo do backtest** (`stepOpenPosition`, extraído do `BacktestRunner`): stop
  dentro do candle (gap na abertura), cruzamento de volta, chandelier, trailing desde a entrada;
- custos do protocolo 1×.

O resultado sai por unidade, em R. Sem ordem, sem saldo.

Um teste mostra que, para os candidatos que o backtest de fato operou, o resultado sombra reproduz o
trade (horário, motivo, preço de saída e R, com precisão de 1e-9).

- **Paper/live:** o worker preenche a cada `CANDIDATE_SHADOW_REFRESH_MINUTES` (padrão 60), com
  `POST /candidates/shadow/refresh` sob demanda. Usa o cache de candles e o klines público.
  `status = OPEN` enquanto nenhuma saída disparou; nesse caso é recalculado na próxima rodada, por até 60 dias.
- **Backtest:** `POST /backtest/run` com `"recordCandidates": true` grava o ledger da execução com o
  resultado sombra, calculado com os candles já carregados (sem rede). Não entra no hash de parâmetros
  e não muda trades nem métricas.

## Juiz (`CandidateJudge`)

```ts
interface CandidateJudge { id: string; assess(input: JudgeInput): Promise<CandidateAssessment> }
```

- `NoopJudge` (`noop:v1`): aprova tudo, sem informação. É a referência de "o juiz não muda nada".
- `BaselineJudge` (`baseline:v1`): repete as regras determinísticas (veredito = decisão da estratégia;
  `setupQuality` = fração de gates aprovados; `warnings` = gates reprovados). É o grupo de controle que
  qualquer juiz de IA terá que superar.
- Não há juiz LLM.

Contrato (`candidate-assessment.contract.ts`, zod):
- `verdict` APPROVE/REJECT/ABSTAIN;
- `setupQuality` inteiro 0–100, **ordinal, não é probabilidade**;
- `regime`;
- `keyFactors`: cada um precisa citar uma feature existente com o valor recebido, senão a avaliação é
  marcada `valid=false`;
- `warnings` de uma lista fechada;
- `rationale` de até 300 caracteres.

**Fora do contrato:** lado, stop e distância do stop, take profit, tamanho, alavancagem, limites de risco
e exposição, número de posições, pausas e saídas. Um stop mais curto vindo de uma IA até **aumentaria**
a posição no sizing de risco fixo.

Modos (`AI_JUDGE_MODE`):
- `off` (padrão): nenhum juiz roda.
- `shadow`: o juiz configurado (`AI_JUDGE=noop|baseline`) avalia cada candidato **depois** que a
  decisão do candle já foi tomada (ordens incluídas), e o resultado só é gravado. Timeout ou erro do
  juiz só perdem a própria avaliação.
- `enforce` é rejeitado pela validação de configuração: nenhum juiz pode mudar uma decisão nesta fase.

## Endpoints

| Rota | O quê |
|---|---|
| `GET /candidates` | Ledger paginado, filtros `mode, runId, symbol, side, setupType, from, to`. |
| `GET /candidates/funnel` | Funil: total, por lado e setup, cada estágio com quantos entraram, quantos foram rejeitados ali e o **resultado sombra dos rejeitados ali** (vitórias, derrotas, R médio). Também os vetos de risco por motivo, o bloco `paused` (candidatos com o bot pausado, bloqueados pela pausa, quantos teriam entrado após um resume, e o resultado sombra deles) e `shadow` (vencedores e perdedores rejeitados, R dos que entraram vs rejeitados). |
| `GET /candidates/pauses` | Cada episódio de pausa com os candidatos que bloqueou e o resultado sombra deles. |
| `GET /bot/pauses` | Episódios de pausa (`pause_episodes`): início, motivo, motivos adicionais, resume, duração. |
| `GET /bot/status` | Agora com `pausedAt` e `pausedForMs` enquanto pausado. |
| `POST /candidates/shadow/refresh` | Calcula agora os resultados sombra pendentes (protegido pela API key). |

## Pausa: o que passa a ser observável

- `bot_state.pausedAt`: início da pausa atual. Uma pausa dentro de outra mantém o início original.
- `pause_episodes`: um documento por pausa, com motivo, `additionalReasons`, `resumedAt` e
  `durationMs`. Se a gravação falhar, a pausa acontece mesmo assim.
- Logs: `Bot paused: CONSECUTIVE_STOPS_LIMIT at … - new entries blocked until POST /bot/resume` e
  `Bot resumed after 3h 30m (pause reason: …)`. O alerta de resume no Discord inclui a duração.
- Os candidatos durante a pausa ficam no ledger com `botPaused`, `rejectedAt = PAUSE`, `riskIfResumed`
  e o resultado sombra. Esses são os "trades perdidos por estar pausado".
