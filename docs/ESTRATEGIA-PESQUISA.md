# Pesquisa técnica — melhorias candidatas para a estratégia

Este documento reúne a pesquisa bibliográfica feita em 2026-09-30 e a decisão sobre cada item.
Regra do projeto: **nenhuma mudança de estratégia/risco em produção sem evidência de backtest
walk-forward fora da amostra** — cada variante testada entra no contador `paramVariationsTestedForStrategy`.

## Status das decisões

### ✅ Implementado nesta rodada (infraestrutura para medir, não mudança de estratégia)
- **Lado Short simétrico** (`allowShort`, padrão desligado): mesmas regras espelhadas, **sem parâmetros novos**
  (a faixa RSI do short é a do long refletida em 50), para não abrir espaço de overfitting.
- **Custo de carregamento do Short no backtest** (`shortBorrowPctPerDay`, padrão 0,03%/dia ≈ componente de juros do
  funding da Binance, 0,01%/8h). Só incide em trades SHORT.
- **Métricas por lado** (`bySide.LONG/SHORT`, `longCount/shortCount`), `grossProfit/grossLoss`, `lossRate`,
  `totalFees`, e no backtest `costs.totalSlippage`, `costs.totalShortCarry` e `exposurePct`.
- **Relatório `GET /reports/by-side`** e filtro `side` em `/reports/*` e `/trades`.
- Correção de risco: stop/take profit do lado errado da entrada agora são vetados
  (`INVALID_STOP_DISTANCE` / `INVALID_TAKE_PROFIT`), antes passavam por causa de `Math.abs`.

### 🧪 Recomendado para testar (backtest walk-forward → paper), em ordem
1. **E3 – Robustez a custos** (fees/slippage 1×, 2×, 3×) — valida a base de custos antes de tudo.
2. **E1 – O Short agrega valor?** Long-only (baseline) vs Long+Short, com `shortBorrowPctPerDay`.
3. **E2 – Ablação do filtro RSI** (com vs sem).
4. **E4 – Risco agregado BTC+ETH ≤ 1,5% no mesmo sentido** (correlação alta entre os dois).
5. **E5 – Filtro ADX(14, 4h) > 20** com valor fixo definido antes do teste.

Critérios de aceitação detalhados na seção 2 abaixo. Como rodar o E1 hoje, sem mudar nada em produção:

```bash
# baseline (long-only)
curl -X POST localhost:8000/backtest/run -H 'Content-Type: application/json' -d '{
  "strategy":"TrendRegimeStrategy","symbols":["BTCUSDT","ETHUSDT"],"timeframe":"1h",
  "from":"2022-01-01","to":"2026-06-30","walkForward":{"testWindowDays":90}}'
# variante (long + short, com custo de carregamento do short)
curl -X POST localhost:8000/backtest/run -H 'Content-Type: application/json' -d '{
  "strategy":"TrendRegimeStrategy","symbols":["BTCUSDT","ETHUSDT"],"timeframe":"1h",
  "from":"2022-01-01","to":"2026-06-30","walkForward":{"testWindowDays":90},
  "strategyParams":{"allowShort":1},"shortBorrowPctPerDay":0.0003}'
```
Compare `summary.bySide`, profit factor, expectancy, max drawdown, Sortino, `costs` e o resultado **por janela**
(`walkForwardWindows`) — nunca só o win rate ou o número de trades.

### ⛔ Não recomendado neste momento
Take profit fixo, Kelly como sizing, MACD (redundante com o cruzamento de EMAs), Markov switching/ML,
grid search amplo, otimizar o Short separadamente do Long, short alavancado em produção.

### 📊 Necessita de dados/backtest antes de alterar produção
Entradas por pullback/limite (reversão intradiária), CPCV/PBO, histerese no filtro de regime, ajustes de
`atrStopMultiplier`/chandelier (procurar platô estável, não o melhor ponto), dados históricos de funding
reais em vez da taxa média fixa.

---

> Escopo: revisão da literatura para embasar decisões. **Nenhuma recomendação aqui autoriza mudar parâmetros de produção sem evidência de backtest walk-forward fora da amostra (OOS).** Toda variante deve ser contabilizada no contador de variações testadas (entra no N do Deflated Sharpe).

## 0. Resumo executivo da pesquisa

- A arquitetura atual (trend following com filtro de regime, stop por ATR, trailing tipo chandelier, sizing de risco fixo) está **alinhada com a literatura**: há evidência robusta de time-series momentum (TSMOM) em futuros tradicionais (Moskowitz/Ooi/Pedersen 2012; Hurst/Ooi/Pedersen 2017) e em cripto (Liu & Tsyvinski, RFS 2021).
- **Atenção:** a evidência de TSMOM em cripto está sobretudo em horizontes de **dias a semanas**. Em **1h–4h**, De Nicola (Ledger, 2021) acha **autocorrelação negativa** (reversão à média) no BTC. Ou seja, o sinal de 1h tende a ter mais ruído e mais custo por trade; o filtro 4h/EMA200 é o que "carrega" o horizonte mais longo.
- **O lado Short não é simétrico** ao Long em cripto: funding em perpétuos (em média os longs pagam, o que favorece o short, mas isso se inverte em pânico), juros de empréstimo em margem (spot short), short squeezes/cascatas de liquidação, retornos com assimetria positiva e "momentum crashes" em repiques (Daniel & Moskowitz 2016). Brock/Lakonishok/LeBaron (1992) também acham sinais de venda com comportamento diferente dos de compra. Espelhar o Long sem testar separadamente é arriscado.
- Prioridade imediata (sem tocar produção): **(1)** modelar custos específicos do short (funding/juros) no backtest; **(2)** reportar métricas por lado (Long vs Short) e métricas anti-overfitting (PSR/DSR, haircut de Harvey-Liu); **(3)** rodar ablação do filtro RSI e do lado Short.

---

## 1. Técnicas

### 1.1 Time-series momentum / trend following (base da estratégia)
1. **O que é:** operar na direção do retorno passado do próprio ativo (long se a tendência é positiva, short se negativa). MOP 2012: 58 futuros líquidos, persistência de 1 a 12 meses com reversão parcial depois. HOP 2017: evidência de 1880 a 2016 em 67 mercados, desempenho forte em crises.
2. **Problema que resolve:** captura tendências persistentes (sub-reação seguida de sobre-reação); gera cauda direita positiva.
3. **Aplicação:** já é o núcleo (cruzamento EMA20/EMA50 + regime EMA200 4h). O importante é o **horizonte efetivo**: EMA20/50 em 1h ≈ 1–2 dias de lookback, bem mais curto que o TSMOM acadêmico. Parâmetros: períodos das EMAs, timeframe do regime.
4. **Dados:** OHLCV 1h/4h (e diário para comparar), vários anos cobrindo bull (2020–21), bear (2022) e lateral.
5. **Riscos:** whipsaw em mercado lateral; custo alto por excesso de trades; reversões bruscas (momentum crashes).
6. **Como testar:** baseline = estratégia atual; variante = mesma lógica com EMAs mais lentas (ex.: equivalente em 4h) → comparar PF OOS, Sharpe/Sortino OOS, nº de trades e custo total como % do PnL bruto, contra buy-and-hold.
7. **Overfitting:** **médio** (a ideia é robusta na literatura; escolher os períodos exatos não é).
8. **Recomendação:** manter a base; **testar em backtest/paper** variações de horizonte (poucas, pré-registradas).

### 1.2 Filtro de regime por média móvel longa (close > EMA200 4h)
1. **O que é:** só operar a favor da tendência de prazo mais longo. Regras de média móvel têm respaldo histórico (Brock, Lakonishok & LeBaron 1992, DJIA 1897–1986, com bootstrap).
2. **Problema:** evita comprar em mercado de baixa; reduz trades contra a tendência dominante.
3. **Aplicação:** já existe. Botões: período (200), timeframe (4h), banda de histerese (ex.: exigir close > EMA200×(1+x) para evitar trocas de regime frequentes), inclinação da EMA200.
4. **Dados:** 4h OHLCV com warm-up suficiente (≥ 200 candles 4h antes do primeiro sinal; cuidado com look-ahead no alinhamento 1h↔4h: usar só o candle 4h **fechado**).
5. **Riscos:** atraso na virada de regime; troca de regime ruidosa perto da média.
6. **Testar:** baseline vs variante com histerese (um valor fixo, ex.: 1%) → nº de trocas de regime, PF OOS, Max DD.
7. **Overfitting:** **baixo** se o teste for de 1–2 variantes; **médio** se varrer muitos períodos.
8. **Recomendação:** **implementar agora** apenas uma verificação de ausência de look-ahead no alinhamento 4h; histerese → **testar em backtest/paper**.

### 1.3 Regime por volatilidade realizada / ADX
1. **O que é:** classificar o mercado como "tendência" vs "lateral" ou "vol baixa" vs "vol alta". ADX (Wilder 1978) mede força de tendência; vol realizada (ex.: desvio-padrão de retornos 1h em janela de 7–30 dias, ou ATR/preço) mede o regime de risco.
2. **Problema:** o cruzamento de EMAs sofre em lateralização; volatilidade extrema aumenta slippage e gaps no stop.
3. **Aplicação:** filtro adicional de entrada (ex.: ADX(14) 4h > limiar) ou bloqueio de entradas quando ATR%/preço está acima de um percentil histórico (calculado só com dados passados).
4. **Dados:** OHLCV; para percentis, janela rolante expansiva (sem olhar o futuro).
5. **Riscos:** mais um parâmetro; reduz nº de trades (menos significância estatística); ADX é atrasado.
6. **Testar:** baseline vs baseline+filtro (limiar fixo definido a priori, ex.: ADX > 20) → PF OOS, expectancy por trade, % de janelas walk-forward em que a variante vence.
7. **Overfitting:** **médio/alto** (limiares são fáceis de ajustar à amostra).
8. **Recomendação:** **testar em backtest/paper**, com no máximo 2–3 valores pré-definidos.

### 1.4 Regime por modelo de Markov (Hamilton 1989)
1. **O que é:** modelo em que os parâmetros (média/variância) mudam conforme um estado latente markoviano; estima a probabilidade de estar em cada regime.
2. **Problema:** detecção de regime "estatística", não baseada em regras ad hoc.
3. **Aplicação:** substituiria/complementaria EMA200 com P(regime de alta).
4. **Dados:** série longa de retornos; reestimação rolante.
5. **Riscos:** instável na reestimação, suavização usa dados futuros (usar só probabilidades *filtradas*), complexidade operacional.
6. **Testar:** só com probabilidades filtradas e reestimação dentro do walk-forward.
7. **Overfitting:** **alto** (nº de estados, especificação, janela).
8. **Recomendação:** **não recomendado agora**.

### 1.5 ATR e stop inicial por volatilidade (Wilder 1978)
1. **O que é:** ATR = média (Wilder) do true range; stop = entrada ± k×ATR.
2. **Problema:** stop proporcional ao ruído corrente; combinado com risco fixo, normaliza o risco por trade.
3. **Aplicação:** já existe (k = 2, ATR 14). Botões: k, período.
4. **Dados:** OHLCV 1h.
5. **Riscos:** k pequeno → stops por ruído (e o 1h do BTC mostra reversão à média, De Nicola 2021, o que penaliza stops apertados); k grande → posição menor, menos retorno.
6. **Testar:** grade pequena k ∈ {1.5, 2, 2.5, 3} **declarada antes**, avaliar estabilidade (platô) e não o melhor ponto.
7. **Overfitting:** **médio**.
8. **Recomendação:** manter k=2; **testar em backtest** só a estabilidade da vizinhança.

### 1.6 Stop-loss (evidência acadêmica — Kaminski & Lo 2014)
1. **O que é:** regra que reduz exposição após perdas acumuladas.
2. **Problema:** limitar perdas. Resultado teórico: sob passeio aleatório, stop-loss simples **sempre reduz** o retorno esperado; com **momentum**, pode agregar valor.
3. **Aplicação:** o stop do bot só "se paga" se o ativo exibir momentum no horizonte do trade. Como o 1h tende à reversão, é esperado que parte dos stops seja ruído. Também se aplica às regras de pausa (3 stops seguidos) e limite diário de 3%.
4. **Dados:** trades do backtest com MAE/MFE (excursão adversa/favorável máxima).
5. **Riscos:** remover o stop aumenta risco de cauda (inaceitável com alavancagem/short).
6. **Testar:** analisar distribuição de MAE dos trades vencedores; testar se a pausa após 3 stops melhora ou piora o OOS (comparar com versão sem pausa **só em backtest**).
7. **Overfitting:** **baixo** para a análise de MAE; **médio** para mexer nas regras de pausa.
8. **Recomendação:** manter stops (controle de risco não é otimizável só por retorno); **testar em backtest** o efeito da regra de pausa.

### 1.7 Trailing stop chandelier (LeBeau)
1. **O que é:** long: máxima de N períodos − m×ATR; short: mínima de N + m×ATR. Padrão de referência: N=22, m=3, **com ATR(22)** (StockCharts).
2. **Problema:** deixa o lucro correr em tendência e trava ganhos.
3. **Aplicação:** já existe com ATR(14); diferença de ATR(14) vs ATR(22) é pequena, mas documente. No short, a mínima de 22 + 3×ATR; em squeezes, o preço pode atravessar o nível entre candles (gap/slippage) → simular preenchimento pelo pior entre stop e open do candle seguinte.
4. **Dados:** OHLCV 1h; idealmente 1m para simular preenchimento intrabar.
5. **Riscos:** sair tarde em reversões em V (comum em cripto); ambiguidade intrabar (stop e máxima no mesmo candle).
6. **Testar:** baseline vs m ∈ {2.5, 3.5}; métricas: captura média da MFE, PF OOS, Max DD.
7. **Overfitting:** **médio**.
8. **Recomendação:** manter; **implementar agora** apenas a regra conservadora de preenchimento no backtest (se ainda não existir).

### 1.8 Take profit fixo / parcial
1. **O que é:** encerrar (total/parcialmente) em alvo de R múltiplos (ex.: 2R).
2. **Problema:** aumenta win rate e suaviza a curva.
3. **Aplicação:** a estratégia não tem TP por design; trend following depende de poucos trades grandes (cauda direita). TP fixo tende a cortar exatamente esses trades.
4. **Dados:** distribuição de R dos trades (quantos trades > 3R e quanto do PnL eles explicam).
5. **Riscos:** reduz expectancy mesmo aumentando win rate; win rate alto ≠ melhor estratégia.
6. **Testar:** calcular a fração do PnL vinda do top 10% de trades; variante TP parcial 50% em 3R → comparar expectancy (R/trade) e PF OOS.
7. **Overfitting:** **médio**.
8. **Recomendação:** **não recomendado agora**; no máximo diagnóstico da distribuição de R.

### 1.9 RSI como filtro de entrada (Wilder 1978)
1. **O que é:** oscilador 0–100; aqui usado como banda [45,70] no long e [30,55] no short para evitar entrar sem força ou já esticado.
2. **Problema:** filtrar cruzamentos fracos e entradas em sobrecompra.
3. **Aplicação:** já existe. Botões: limites da banda, período.
4. **Dados:** OHLCV 1h.
5. **Riscos:** bandas são 2 parâmetros por lado (4 no total) sem fundamento acadêmico forte; podem cortar justamente as tendências mais fortes (RSI > 70 em breakouts).
6. **Testar:** **ablação**: baseline (com RSI) vs sem RSI → se a diferença OOS não for significativa, o filtro é complexidade sem valor.
7. **Overfitting:** **alto** se as bandas foram escolhidas olhando o backtest.
8. **Recomendação:** **testar em backtest/paper** (ablação) antes de qualquer ajuste de banda.

### 1.10 MACD
1. **O que é:** diferença entre EMAs (tipicamente 12/26) e sua EMA de sinal (9) (Appel; livro, URL não verificada).
2. **Problema:** sinal de momentum/tendência.
3. **Aplicação:** seria essencialmente redundante com o cruzamento EMA20/EMA50 (o cruzamento é o MACD cruzando zero, com outros períodos).
4. **Dados:** OHLCV.
5. **Riscos:** filtro redundante → mais parâmetros, mesma informação.
6. **Testar:** não necessário.
7. **Overfitting:** **médio/alto** (3 parâmetros adicionais).
8. **Recomendação:** **não recomendado agora**.

### 1.11 Reversão à média intradiária
1. **O que é:** apostar contra movimentos recentes. De Nicola (2021): autocorrelação negativa em 1h/2h/4h no BTC, mais forte após movimentos grandes (sobre-reação, excesso de vol, liquidações forçadas). Quantpedia (2022, pesquisa de blog, não peer-reviewed): BTC mostra momentum em máximas locais e reversão em mínimas.
2. **Problema:** explora ineficiência de curto prazo; implica que entradas "no rompimento" em 1h pagam um prêmio ruim.
3. **Aplicação:** não como estratégia separada agora; possível uso futuro: entrar no pullback após o cruzamento (ordem limite a EMA20) em vez de a mercado — também reduz taxa (maker).
4. **Dados:** OHLCV 1h, livro de ofertas para simular preenchimento de limite.
5. **Riscos:** conflito de lógica com trend following; ordens limite não executadas (perde as melhores tendências — viés de seleção adverso).
6. **Testar:** variante "entrada limite no pullback com timeout de N candles" vs baseline; medir taxa de preenchimento e expectancy.
7. **Overfitting:** **alto**.
8. **Recomendação:** **precisa de dados/backtest antes** (simulação realista de ordens limite).

### 1.12 Volatility targeting (nível de portfólio)
1. **O que é:** escalar a exposição para uma vol-alvo (exposição ∝ σ_alvo/σ_estimada). Moreira & Muir (JF 2017): aumenta Sharpe de vários fatores, incluindo momentum. Harvey et al. (JPM 2018): melhora Sharpe em ativos de risco (ações, crédito), efeito pequeno em bonds/FX/commodities, mas **reduz caudas em todas as classes**. MOP 2012 também escala por volatilidade.
2. **Problema:** evita que períodos de vol alta dominem o risco e o drawdown.
3. **Aplicação:** o sizing por 1% de risco / distância de stop (2×ATR) **já é um vol targeting por trade**. O que falta é o nível de portfólio: BTC e ETH são muito correlacionados; duas posições simultâneas ≈ ~2% de risco no mesmo fator. Botão possível: reduzir risco por trade quando há posição aberta no outro ativo na mesma direção, ou limitar risco agregado.
4. **Dados:** vol realizada e correlação BTC/ETH rolantes.
5. **Riscos:** estimativa de vol atrasada em choques; alavancagem implícita em vol baixa (limitar pelo cap de exposição existente).
6. **Testar:** baseline vs "risco agregado máximo de 1.5% no mesmo sentido" → Max DD, Calmar, Sortino OOS.
7. **Overfitting:** **baixo** (regra de risco, não de sinal).
8. **Recomendação:** **testar em backtest/paper**; forte candidata.

### 1.13 Position sizing: fração fixa vs Kelly
1. **O que é:** Kelly maximiza o crescimento log da riqueza; na prática se usa Kelly fracionário (Thorp) porque o edge estimado tem erro.
2. **Problema:** dimensionar para crescimento sem ruína.
3. **Aplicação:** 1% de risco fixo é conservador e adequado. Kelly exige estimar win rate e payoff com precisão que o backtest (dezenas/centenas de trades) não dá; erro de estimativa leva a over-betting.
4. **Dados:** muitas centenas de trades OOS por lado.
5. **Riscos:** drawdowns severos se o edge real for menor que o estimado.
6. **Testar:** calcular Kelly implícito dos trades OOS só como *diagnóstico* (se 1% for > ¼ Kelly, o risco está alto demais).
7. **Overfitting:** **alto** (depende de estimativas do próprio backtest).
8. **Recomendação:** **não recomendado agora** mudar sizing; manter 1% (ou menos no short, ver 1.14).

### 1.14 Assimetria Long vs Short em cripto
1. **O que é:** o short não é o espelho do long. Fatores:
   - **Funding (perpétuos Binance):** troca a cada 8h (00/08/16 UTC, podendo ser mais frequente em volatilidade extrema); componente de juros 0.01%/8h; funding positivo → longs pagam shorts; negativo → shorts pagam longs; só paga quem está posicionado no instante do funding. He, Manela, Ross & von Wachter (arXiv 2212.06888): desvios dos perpétuos em relação ao spot são grandes, então funding pode ser material.
   - **Short em margem spot:** juros horários sobre o ativo emprestado (cobrança mínima de 1h), taxas variam (consultar página Margin Data).
   - **Short squeezes / cascatas de liquidação:** subidas bruscas em que stops de short sofrem slippage grande.
   - **Momentum crashes (Daniel & Moskowitz 2016):** momentum tem perdas concentradas em repiques após quedas, com vol alta — exatamente o cenário de um short em regime de baixa.
   - **Brock et al. 1992:** sinais de compra e venda de MAs têm propriedades diferentes (retornos/volatilidade distintos).
   - Deriva positiva de longo prazo do BTC/ETH: o short luta contra a média.
2. **Problema:** evitar supor que a expectancy do short será igual à do long.
3. **Aplicação:** tratar o short como estratégia separada no relatório: custos próprios (funding/juros), parâmetros **não** reotimizados separadamente de início (usar os espelhados para não dobrar os graus de liberdade), e considerar risco por trade menor (ex.: 0.5%) **se** o backtest mostrar maior cauda adversa. Contabilizar o limite diário e a pausa de 3 stops por lado ou global (decidir e documentar).
4. **Dados:** histórico de funding (endpoint da Binance), taxas de juros de margem, OHLCV 1m para squeezes.
5. **Riscos:** o maior da lista — perdas de cauda e custos de carregamento; menor amostra de regimes de baixa (2018, 2022) → pouca significância.
6. **Testar:** backtest com três configurações: Long-only (baseline), Long+Short, Short-only; com funding/juros modelados; relatar métricas por lado e por janela. Critério: Long+Short deve melhorar o Sharpe/Calmar OOS do portfólio **e** o Short-only deve ter PF OOS > 1 com custos.
7. **Overfitting:** **alto** se ajustar parâmetros do short à parte (poucos bear markets na amostra).
8. **Recomendação:** **testar em backtest/paper** (não ligar em produção antes). Em produção, se for aprovado, começar com risco reduzido.

### 1.15 Custos de transação e slippage
1. **O que é:** taxas + spread + impacto + funding/juros. Binance spot: ~0.10% maker/taker na base (descontos por VIP/BNB). USDⓈ-M futures: 0.02% maker / 0.05% taker para usuário regular (FAQ oficial).
2. **Problema:** estratégias de 1h com muitos cruzamentos podem ter o edge consumido pelos custos.
3. **Aplicação:** o engine já tem fees e slippage; garantir: (a) fee do instrumento real (spot vs futures), (b) funding por posição aberta nos horários de funding, (c) juros de margem no short spot, (d) slippage maior em stops (ordens stop-market) do que em entradas, (e) slippage condicional à volatilidade.
4. **Dados:** histórico de funding e juros; spreads/profundidade (opcional).
5. **Riscos:** subestimar custo → estratégia "lucrativa" só no papel.
6. **Testar:** stress 1×, 2× e 3× custos; a estratégia deve continuar com PF OOS > 1 a 2×.
7. **Overfitting:** **baixo** (é realismo, não ajuste).
8. **Recomendação:** **implementar agora** (no backtest, não em produção).

### 1.16 Walk-forward e validação cruzada combinatória purgada
1. **O que é:** walk-forward = otimizar em janela in-sample e avaliar na seguinte OOS, rolando. López de Prado (Advances in Financial Machine Learning) propõe purged k-fold e CPCV (com embargo) para gerar muitos caminhos OOS e reduzir a dependência de um único caminho histórico.
2. **Problema:** um único caminho walk-forward é uma única amostra; resultados dependem da ordem dos regimes.
3. **Aplicação:** o engine já faz walk-forward. Garantir: (a) warm-up dos indicadores antes de cada janela OOS; (b) trades abertos na fronteira tratados de forma consistente; (c) relatório agregando **apenas** OOS.
4. **Dados:** mesmo histórico.
5. **Riscos:** janelas muito curtas → poucos trades por janela; janelas escolhidas a posteriori.
6. **Testar:** fixar tamanhos de janela antes (ex.: 12 meses IS / 3 meses OOS) e não mudá-los depois de ver o resultado.
7. **Overfitting:** **baixo** (é ferramenta anti-overfitting), desde que as janelas não sejam elas mesmas otimizadas.
8. **Recomendação:** walk-forward atual: manter; CPCV/PBO: **precisa de dados/backtest antes** (implementação mais complexa, útil quando houver muitas variantes).

### 1.17 Métricas de desempenho e anti-overfitting (Sharpe, Sortino, DSR, PBO, haircut)
1. **O que é:**
   - Sharpe; **Sortino** (Sortino & van der Meer 1991: penaliza só a volatilidade negativa — relevante porque trend following tem assimetria positiva); Max DD e Calmar; win rate; **expectancy** (média de R por trade = win%×ganho médio − loss%×perda média); profit factor.
   - **Deflated Sharpe Ratio** (Bailey & López de Prado 2014): corrige o Sharpe por nº de tentativas, assimetria e curtose.
   - **PBO via CSCV** (Bailey, Borwein, López de Prado & Zhu 2015): probabilidade de que a melhor configuração in-sample fique abaixo da mediana OOS.
   - **Haircut de Harvey & Liu (JPM 2015):** ajuste do Sharpe por testes múltiplos (Bonferroni/Holm/BHY); um desconto fixo de 50% é leniente para Sharpe baixo e severo para Sharpe alto.
2. **Problema:** o melhor de N backtests é enviesado para cima; win rate sozinho engana.
3. **Aplicação:** o engine já conta variações testadas → usar esse N diretamente no DSR. Reportar métricas **por lado** (Long/Short), por ativo e agregadas; usar retornos por barra/dia (não por trade) para Sharpe/Sortino anualizados com fator correto para cripto 24/7 (365 dias; 8760 h).
4. **Dados:** série de equity OOS, lista de trades, N de variantes, variância dos Sharpes entre variantes (para o DSR).
5. **Riscos:** anualização errada; N subestimado (contar também os testes "informais").
6. **Testar:** não é variante — é relatório. Validar a implementação do DSR contra um exemplo numérico do paper.
7. **Overfitting:** reduz o risco.
8. **Recomendação:** **implementar agora** (só relatório de backtest).

---

## 2. Experimentos priorizados (mensuráveis)

Regras comuns: janelas walk-forward fixadas **antes**; resultado julgado **somente no agregado OOS**; custos com funding/juros; cada variante incrementa o contador de variações; comparar sempre contra baseline atual **e** buy-and-hold. Mínimo de ~30 trades OOS por lado para qualquer conclusão (abaixo disso: "inconclusivo").

| # | Hipótese | Variante vs baseline | Métricas | Critério de aceitação |
|---|---|---|---|---|
| E1 | O Short agrega valor ao portfólio após custos reais | Long-only (baseline) vs Long+Short vs Short-only, com funding (futures) ou juros (margem) modelados | PF OOS por lado, Sharpe/Sortino/Calmar do portfólio, Max DD, DSR | Short-only PF OOS > 1.1 com custos 1× e > 1.0 com 2×; Long+Short com Calmar OOS ≥ baseline e Max DD ≤ 1.2× baseline; DSR (prob.) ≥ 0.95; melhora em ≥ 60% das janelas |
| E2 | O filtro RSI não adiciona valor (ablação) | Com RSI (baseline) vs sem RSI | Expectancy (R/trade) OOS, PF OOS, nº de trades, DSR | Manter RSI só se PF OOS e expectancy forem melhores em ≥ 60% das janelas **e** a diferença sobreviver a custos 2×; caso contrário, preferir a versão mais simples |
| E3 | Robustez a custos | Custos 1×, 2×, 3× (fees + slippage de stop maior) | PF OOS, retorno líquido, custo total / PnL bruto | PF OOS > 1.0 a 2× custos; custo total < 50% do PnL bruto a 1× |
| E4 | Controle de risco agregado BTC+ETH reduz DD sem destruir retorno | Baseline vs risco agregado máximo 1.5% no mesmo sentido | Max DD, Calmar, Sortino OOS | Max DD OOS ≤ 0.85× baseline e Calmar ≥ baseline |
| E5 | Filtro de regime de tendência/volatilidade reduz whipsaw | Baseline vs + ADX(14,4h) > 20 (valor fixo a priori) | PF OOS, expectancy, nº de trades, % de janelas vencidas | PF OOS ≥ 1.1× baseline em ≥ 60% das janelas, nº de trades ainda ≥ 30/lado, DSR ≥ 0.95 considerando o N total |

Ordem sugerida: E3 → E1 → E2 → E4 → E5 (E3 valida a base de custo usada nos demais).

## 3. O que NÃO é recomendado agora

- Alterar qualquer parâmetro de produção (EMAs, bandas RSI, k do ATR, multiplicador chandelier, risco 1%) sem passar pelos critérios acima.
- Otimizar os parâmetros do Short separadamente do Long (dobra os graus de liberdade com poucos bear markets na amostra).
- Kelly (inteiro ou fracionário) como sizing — edge estimado com erro grande.
- Take profit fixo — conflita com a cauda direita do trend following.
- MACD ou outros osciladores redundantes com o cruzamento de EMAs.
- Hamilton/Markov switching, ML ou "regime detection" sofisticado antes de esgotar filtros simples.
- Grid search amplo (muitas combinações) — aumenta N, derruba o DSR e o PBO fica alto.
- Ligar o Short em produção com alavancagem antes de paper trading com funding/juros reais.
- Julgar variantes por win rate ou por lucro in-sample.

## 4. Fontes

Visitadas (páginas abertas ou resultados verificados em busca):
- Moskowitz, Ooi, Pedersen (2012), *Time Series Momentum*, JFE — https://papers.ssrn.com/abstract=2089463
- Hurst, Ooi, Pedersen (2017), *A Century of Evidence on Trend-Following Investing*, JPM — https://www.aqr.com/Insights/Research/Journal-Article/A-Century-of-Evidence-on-Trend-Following-Investing
- Liu & Tsyvinski, *Risks and Returns of Cryptocurrency*, RFS 2021 — https://www.nber.org/papers/w24877 (aberto) ; https://ideas.repec.org/a/oup/rfinst/v34y2021i6p2689-2727..html
- Liu, Tsyvinski & Wu, *Common Risk Factors in Cryptocurrency*, JF 2022 — https://papers.ssrn.com/abstract=3379131 ; https://www.nber.org/papers/w25882.pdf
- De Nicola (2021), *On the Intraday Behavior of Bitcoin*, Ledger — https://ledger.pitt.edu/ojs/ledger/article/view/213 (aberto)
- Padyšák & Vojtko (Quantpedia, 2022), *Trend-Following and Mean-Reversion in Bitcoin* (blog de pesquisa, não peer-reviewed) — https://quantpedia.com/trend-following-and-mean-reversion-in-bitcoin/ (aberto)
- Bailey & López de Prado (2014), *The Deflated Sharpe Ratio* — https://papers.ssrn.com/abstract=2460551 (visto na busca; acesso direto retornou 403)
- Bailey, Borwein, López de Prado, Zhu (2015), *The Probability of Backtest Overfitting*, J. Computational Finance — https://papers.ssrn.com/abstract=2326253 ; https://escholarship.org/content/qt4w1110bb/qt4w1110bb.pdf
- Harvey & Liu (2015), *Backtesting*, JPM — https://people.duke.edu/~charvey/Research/Published_Papers/P120_Backtesting.PDF (PDF baixado; conteúdo textual não extraído pela ferramenta — detalhes de Bonferroni/Holm/BHY vêm do resumo da busca e conhecimento do artigo)
- Kaminski & Lo (2014), *When Do Stop-Loss Rules Stop Losses?*, J. Financial Markets — https://dspace.mit.edu/handle/1721.1/114876 (aberto) ; https://ideas.repec.org/a/eee/finmar/v18y2014icp234-254.html
- Moreira & Muir (2017), *Volatility-Managed Portfolios*, JF — https://www.nber.org/papers/22208
- Harvey et al. (2018), *The Impact of Volatility Targeting*, JPM — https://scholars.duke.edu/publication/1370354
- Daniel & Moskowitz (2016), *Momentum Crashes*, JFE — https://www.nber.org/papers/w20439
- Brock, Lakonishok & LeBaron (1992), *Simple Technical Trading Rules...*, JF — https://ideas.repec.org/a/bla/jfinan/v47y1992i5p1731-64.html
- Hamilton (1989), Econometrica 57(2) — https://ideas.repec.org/a/ecm/emetrp/v57y1989i2p357-84.html
- He, Manela, Ross, von Wachter, *Fundamentals of Perpetual Futures* — https://arxiv.org/abs/2212.06888v6
- Chandelier Exit (LeBeau; StockCharts ChartSchool) — https://chartschool.stockcharts.com/table-of-contents/technical-indicators-and-overlays/technical-overlays/chandelier-exit (aberto)
- Thorp, *The Kelly Criterion in Blackjack, Sports Betting and the Stock Market* — https://sites.oxy.edu/lengyel/M330/thorp/paper.htm
- Purged CV / CPCV (López de Prado) — https://en.wikipedia.org/wiki/Purged_cross-validation (fonte secundária)
- Binance — Funding rate (aberto): https://www.binance.com/en/support/faq/detail/360033525031
- Binance — Futures fees (aberto; 0.02% maker / 0.05% taker regular): https://www.binance.com/en/support/faq/detail/360033544231
- Binance — Spot fees: https://www.binance.com/en/fee/schedule ; https://www.binance.com/en/support/faq/detail/e85d6e703b874674840122196b89780a
- Binance — Margem isolada / juros: https://www.binance.com/en/support/faq/0135c8c00a4240f695ee71a0d18efb08 ; https://www.binance.com/en/margin-fee

Não verificadas por URL (referências de livro/artigo citadas de memória):
- Wilder, J. W. (1978), *New Concepts in Technical Trading Systems* (RSI, ATR, ADX) — só fontes secundárias vistas (ex.: https://www.macroption.com/new-concepts-in-technical-trading-systems/).
- Sortino & van der Meer (1991), "Downside Risk", JPM 17(4):27–31 — referência confirmada apenas por fonte secundária.
- López de Prado (2018), *Advances in Financial Machine Learning*, Wiley.
- Appel, G., MACD (livro); Pardo, R., *The Evaluation and Optimization of Trading Strategies* (walk-forward).
- "Catching Crypto Trends" (Swiss Finance Institute RP 25-80) — página retornou 502, não verificada.
- Taxas da Binance mudam com o tempo e por VIP/BNB: confirmar os valores vigentes antes de fixá-los no backtest.
