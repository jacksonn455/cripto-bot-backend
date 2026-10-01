# Pesquisa V0–V3: resultado (2026-09-30)

Protocolo pré-registrado em [ESTRATEGIA-PESQUISA.md §5](../ESTRATEGIA-PESQUISA.md) antes de qualquer resultado.
Os critérios não foram alterados depois. Os números completos estão em `variants-results.json`, gerado por
[`src/research/variants.research.spec.ts`](../../src/research/variants.research.spec.ts) (reproduzível com
`RUN_RESEARCH=1`).

**Desenho:**
- Ativos: BTC, ETH, BNB, SOL e XRP, no 1h, com regime em 4h.
- Desenvolvimento (DEV): 2023-01 → 2024-12. Fora da amostra (OOS): 2025-01 → 2026-09.
- Walk-forward de 90 dias.
- Carteira única com os 5 ativos e 10.000 USDT; também cada ativo sozinho.
- Custos 1×: taxa 0,10% por lado, slippage 0,05%, slippage do stop 0,10%, custo do short 0,03% ao dia. Custos 2×: tudo dobrado.
- Motor v2: stop com gap preenche na abertura; a pausa por stops seguidos dura até o dia seguinte.
- 208 simulações no total.

## Conclusão

**Nenhuma variante passou. Nada muda no paper.**

- **O long não tem edge depois dos custos.**
  - O melhor caso é o V0 (a estratégia atual). Em DEV, com o mercado em forte alta (comprar e segurar a carteira deu +628%), ele fez +10,5% com PF 1,09. Fora da amostra, com o mercado em queda (−18%), fez −6,2% com PF 0,91.
  - Com custos 2×, o PF cai abaixo de 1 nos dois períodos.
  - DSR de 0,04 a 0,16, contra o mínimo de 0,95.
- **O short não agrega.** Em todas as variantes ele perde e aumenta o drawdown, e reprova em todos os itens do critério C. Deve continuar desligado.
- **As "correções" V1 pioraram o resultado.** O trailing desde a entrada aperta cedo e corta a cauda direita: o tempo médio em posição caiu de 21 h para 16 h, e 70% das saídas passaram a ser por trailing. A janela rolante "errada" do V0 funcionava como um trailing mais largo, e isso ajudava.
- **O V3 (pullback) é o caso de "mais trades com sinal pior":** quase triplicou os trades e piorou PF, drawdown e Sharpe nos dois períodos e em todos os ativos.
- **PBO baixo (0,07 só long; 0,06 long + short):** o ranking entre as variantes é estável, e o V0 é o melhor em mais de 90% das divisões. Isso não significa que ele ganhe dinheiro. Significa só que as variantes testadas pioram o V0 de forma consistente.
- **Custos:** no V0 só long fora da amostra, os custos consomem 34% do lucro bruto com custos 1× e 74% com 2×. O edge bruto existe, mas é pequeno demais para o horizonte de 1h.

## Carteira, fora da amostra (2025-01 → 2026-09), custos 1×

| | V0 | V1 | V2 | V3 |
|---|---|---|---|---|
| **Só long** | | | | |
| Trades | 239 | 245 | 259 | 656 |
| Win rate | 28,0% | 27,3% | 29,0% | 26,4% |
| Profit factor | 0,91 | 0,71 | 0,79 | 0,71 |
| Expectância (USDT por trade) | −2,61 | −7,49 | −5,56 | −6,47 |
| Retorno | −6,2% | −18,4% | −14,4% | −42,5% |
| Max drawdown (curva diária) | 22,0% | 27,7% | 23,4% | 50,4% |
| Sharpe / Sortino anualizados | −0,25 / −0,45 | −1,11 / −1,93 | −0,80 / −1,43 | −1,58 / −2,56 |
| CAGR / Calmar | −3,6% / −0,16 | −10,9% / −0,39 | −8,5% / −0,36 | −27,1% / −0,54 |
| Volatilidade anual | 12,0% | 10,0% | 10,4% | 18,9% |
| Maior sequência de perdas | 19 | 15 | 15 | 26 |
| Tempo médio em posição | 21 h | 16 h | 16 h | 16 h |
| Janelas positivas | 3/7 | 0/7 | 0/7 | 0/7 |
| Fatia do lucro bruto dos 10% melhores trades | 80% | 80% | 77% | 84% |
| **Long + short** | | | | |
| Trades (long/short) | 529 (228/301) | 571 (242/329) | 604 (256/348) | 1446 (626/820) |
| Profit factor | 0,91 | 0,78 | 0,80 | 0,70 |
| Retorno | −13,9% | −30,1% | −29,3% | −69,1% |
| Max drawdown | 30,5% | 38,8% | 37,7% | 70,0% |
| PF / PnL do lado long | 0,86 / −986 | 0,72 / −1755 | 0,80 / −1342 | 0,64 / −3661 |
| PF / PnL do lado short | 0,95 / −403 | 0,83 / −1255 | 0,81 / −1586 | 0,75 / −3250 |

Comprar e segurar fora da amostra: BTC −11%, ETH −20%, BNB +8%, SOL −39%, XRP −29% (carteira com pesos iguais: −18%).

## Robustez: profit factor da carteira com custos 1× → 2×

| | V0 | V1 | V2 | V3 |
|---|---|---|---|---|
| DEV, só long | 1,09 → 0,85 | 0,91 → 0,68 | 0,85 → 0,64 | 0,90 → 0,63 |
| DEV, long + short | 0,80 → 0,58 | 0,75 → 0,53 | 0,72 → 0,51 | 0,69 → 0,46 |
| OOS, só long | 0,91 → 0,67 | 0,71 → 0,50 | 0,79 → 0,55 | 0,71 → 0,52 |
| OOS, long + short | 0,91 → 0,69 | 0,78 → 0,57 | 0,80 → 0,59 | 0,70 → 0,50 |

Retorno em DEV, só long, custos 1×: V0 +10,5% · V1 −9,5% · V2 −16,2% · V3 −23,0%. Com custos 2×: −17,9% · −34,9% · −41,7% · −68,8%.

## Por ativo (cada um sozinho, 10.000 USDT, só long): PF com custos 1×, retorno e número de trades

| Ativo | DEV comprar e segurar | DEV V0 | DEV V1 | DEV V2 | DEV V3 | OOS comprar e segurar | OOS V0 | OOS V1 | OOS V2 | OOS V3 |
|---|---|---|---|---|---|---|---|---|---|---|
| BTC | +466% | 0,67 / −7,0% (76) | 0,44 | 0,42 | 0,81 | −11% | 0,33 / −10,3% (61) | 0,41 | 0,40 | 0,56 |
| ETH | +180% | **1,83 / +15,4% (67)** | 1,32 | 1,25 | 0,90 | −20% | 0,70 / −7,9% (70) | 0,64 | 0,65 | 0,74 |
| BNB | +186% | 0,80 / −6,0% (100) | 0,59 | 0,61 | 0,69 | +8% | 0,76 / −4,9% (79) | 0,72 | 0,70 | 0,63 |
| SOL | +1795% | **1,53 / +20,6% (77)** | 1,37 | 1,29 | 0,94 | −39% | **1,43 / +8,1% (58)** | 0,69 | 0,79 | 0,82 |
| XRP | +516% | 0,41 / −13,8% (66) | 0,60 | 0,76 | 0,84 | −29% | 0,91 / −1,7% (47) | 0,84 | 0,81 | 0,69 |

Ativos com PF > 1 fora da amostra, de 5 (critério A5 pede 3): V0 1, V1 0, V2 0, V3 0. O resultado depende de poucos ativos e
de poucos trades: os 10% melhores trades fazem cerca de 80% do lucro bruto em todas as variantes.

## Walk-forward: trades por janela de 90 dias (carteira, só long, custos 1×)

- DEV, V0: 48, 31, 19, 57, 59, 37, 17, 56 (e 5 na janela residual). 4 de 8 janelas positivas.
- OOS, V0: 30, 39, 59, 9, 18, 27, 49 (e 8). 3 de 7 janelas positivas. V1, V2 e V3 tiveram 0 de 7.

Os trades estão distribuídos no tempo, sem concentração numa janela só. O problema não é falta de oportunidades: com a
trava corrigida, o V0 faz de 135 a 165 trades por ano na carteira. O problema é a qualidade do sinal depois dos custos.

## Sensibilidade (fora da amostra, só long, custos 1×; não serviu para escolher nada)

| | stop 1,5×ATR | stop 2,5×ATR | chandelier 2,5 | chandelier 3,5 |
|---|---|---|---|---|
| V0 | PF 0,80 | **0,99** | 0,81 | 0,82 |
| V1 | 0,70 | 0,75 | 0,69 | 0,80 |
| V2 | 0,77 | 0,83 | 0,74 | 0,86 |
| V3 | 0,74 | 0,72 | 0,68 | 0,72 |

Não existe um platô acima de 1: nenhum vizinho do V0 tem edge. O stop de 2,5×ATR chega a PF 0,99, mas escolhê-lo agora
seria exatamente o overfitting que o protocolo proíbe.

## Critérios (só long, fora da amostra)

| Critério | V0 | V1 | V2 | V3 |
|---|---|---|---|---|
| A1: ≥ 30 trades por lado | ✓ 239 | ✓ 245 | ✓ 259 | ✓ 656 |
| A2: PF ≥ 1,1 com 1× e > 1 com 2× | ✗ 0,91 / 0,67 | ✗ 0,71 / 0,50 | ✗ 0,79 / 0,55 | ✗ 0,71 / 0,52 |
| A3: DSR ≥ 0,95 (N = 24) | ✗ 0,04 | ✗ 0,004 | ✗ 0,009 | ✗ 0,001 |
| A4: ≥ 60% das janelas positivas | ✗ 3/7 | ✗ 0/7 | ✗ 0/7 | ✗ 0/7 |
| A5: PF > 1 em ≥ 3 ativos | ✗ 1 | ✗ 0 | ✗ 0 | ✗ 0 |
| B1: PF e expectância melhores que V0 em ≥ 60% das janelas | — | ✗ 43% | ✗ 57% | ✗ 14% |
| B2: R médio ≥ o de V0 | — | (no próximo commit) | (no próximo commit) | (no próximo commit) |
| B3: max drawdown ≤ 1,2× o de V0 | — | ✗ 27,7% vs 22,0% | ✓ 23,4% | ✗ 50,4% |
| B4: PF com 2× ≥ o de V0 | — | ✗ | ✗ | ✗ |
| B5: PBO < 0,5 | — | ✓ 0,07 | ✓ 0,07 | ✓ 0,07 |
| C: o short agrega | ✗ | ✗ | ✗ | ✗ |

Long + short reprova nos mesmos itens: PF fora da amostra de 0,70 a 0,91, DSR ≤ 0,03 e no máximo 2 de 7 janelas positivas.

> Nota de medição: na primeira rodada, o R das variantes com trailing usava o stop final (que já tinha subido até perto
> da entrada) em vez do stop inicial, e por isso saía entre −0,8 e −3,6. O motor foi corrigido: a trade agora grava o stop
> com que a posição foi dimensionada. As simulações estão rodando de novo só para atualizar o R médio. Nenhum outro
> número desta página depende disso.

## O que fazer

1. **Paper:** continua no V0, só long, como observação, porque o short reprova no critério C. Recomendo
   `TREND_ALLOW_SHORT=false` no Render; hoje está `true`. A correção da trava (motor e risco) já vai junto deste commit.
2. **Não levar nenhuma das variantes V1, V2 ou V3 para o paper.**
3. **Próxima pesquisa, se houver,** com protocolo novo e N acumulado (as 24 tentativas desta rodada continuam contando):
   - o horizonte de 1h é o problema mais provável, já que a literatura aponta reversão à média no intradiário, então
     testar o mesmo desenho com o sinal em 4h ou diário;
   - separar o V1 nas suas duas partes (só o regime corrigido; só o trailing), porque juntas elas confundem o efeito;
   - reduzir custo com ordens limite (maker), já que os custos consomem de 34% a 74% do lucro bruto.
