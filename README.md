# App de Treino

App pessoal para registrar musculação no celular. É um único `index.html` que grava numa planilha Google por meio de um Apps Script. Os requisitos estão em [App de Treino — Requisitos.md](App%20de%20Treino%20—%20Requisitos.md).

```
index.html            o app inteiro (HTML + CSS + JS, sem build)
apps-script/Code.gs   back-end: colar no editor do Apps Script da planilha
testes/rodar.js       testes da regra de sugestão e da fila (Node, sem dependências)
testes/e2e.js         treino completo num navegador headless contra um Web App falso
```

## Instalação (uma vez, ~10 min)

1. **Planilha.** Crie uma planilha Google vazia e abra *Extensões › Apps Script*.
2. **Script.** Apague o conteúdo de `Código.gs` e cole o de [apps-script/Code.gs](apps-script/Code.gs). Salve.
3. **Setup.** Escolha a função `setup` e clique em *Executar*. Autorize o acesso à planilha.
   - Ela cria as 6 abas, os cabeçalhos e os valores padrão da aba `Config`.
   - Ela gera o **TOKEN** nas Script Properties. Copie-o em *Execuções › Log*.
   - Opcional: rode `seedExemplo` para ter um catálogo e três planos de exemplo.
   - Opcional: rode `testarApi` para um teste de fumaça da gravação.
4. **Publicar.** Vá em *Implantar › Nova implantação › App da Web*, com *Executar como: Eu* e *Quem pode acessar: Qualquer pessoa*. Copie a URL que termina em `/exec`.
5. **Hospedar o HTML (GitHub Pages).** Suba o `index.html` num repositório e ative *Settings › Pages* (branch `main`, pasta raiz). O app fica em `https://<usuario>.github.io/<repo>/`.
6. **Celular.** Abra o endereço e vá em *Config*. Cole a URL e o token, toque em *Testar* e depois em *Salvar*. Adicione à tela inicial (*Compartilhar › Adicionar à Tela de Início* no iPhone; *⋮ › Adicionar à tela inicial* no Android).

> **Ao alterar o `Code.gs`:** use *Implantar › Gerenciar implantações › Editar › Nova versão*. Assim a URL continua a mesma.
> **Para trocar o token:** rode `trocarToken` e informe o novo token no app.

## Uso

- **Treinar:** toque em *Iniciar treino* num plano ou em *Sessão livre*. O cronômetro geral começa no toque.
- **Registrar uma série:** peso e repetições já vêm com a sugestão. Ajuste com − e + se precisar e toque em *Registrar*. RIR e aquecimento são opcionais.
- **Descanso:** começa sozinho ao registrar a série. Os botões ±15 s ajustam o tempo. Há um aviso discreto 10 s antes do fim. No zero tocam som, vibração e flash, e depois a contagem segue em tempo extra. *Iniciar próxima série* grava quanto você descansou de fato.
- **Exercícios da sessão (toque no nome):** trocar de exercício, reordenar, pular, adicionar exercício. Para uma série extra, basta registrar de novo num exercício já concluído.
- **Fim:** o resumo abre sozinho na última série planejada, com *Continuar treinando* e *Concluir*. O menu ⋮ permite encerrar antes ou descartar o treino.
- **Sem sinal:** tudo é gravado primeiro no aparelho. O indicador no topo mostra *sincronizado*, *N pendentes* ou *erro*, e a fila é enviada quando a rede volta.

## Testes

```bash
node testes/rodar.js        # regra de sugestão, fila, recordes (sem dependências)
npm i && npm run e2e        # treino completo no Edge headless (NAVEGADOR=... para outro Chromium)
```

No celular, abra `index.html?test` para rodar os mesmos testes da regra no navegador.

## Decisões de implementação

Os pontos que o documento de requisitos deixava em aberto foram resolvidos assim:

| Ponto | Decisão |
| --- | --- |
| Editar ou excluir série já sincronizada | A API faz **upsert e delete por ID**, em vez de só ignorar IDs repetidos. Reenviar continua seguro: o upsert é idempotente e apagar duas vezes não faz nada. Na fila, upserts pendentes do mesmo registro são juntados. |
| Snapshot do plano | `Sessoes` ganhou `plano_nome`, `series_planejadas`, `series_feitas` e `volume_kg`. Editar o plano depois não muda o histórico. |
| Itens do plano | `PlanoItens` ganhou a chave `item_id`, necessária para o upsert. |
| Carga base quando as séries variaram | Vale a carga mais frequente da última sessão; em empate, a maior. |
| "Todas as séries no máximo" | Exige pelo menos o número de séries do plano. Fazer só 2 de 3 séries com 12 repetições não sobe a carga. |
| Exercício sem incremento (0) | Na regra 2, mantém a carga e sugere o máximo da faixa. |
| Volume | Halter conta os dois halteres (×2). Peso corporal conta só a carga adicional. Aquecimento não conta. |
| Recorde pessoal | Maior 1RM estimado (Epley) ou maior carga, comparados com o histórico anterior à sessão. A primeira vez num exercício não conta como recorde. |
| `descanso_real_s` | Fica na série que **antecede** o descanso. |
| `ordem_exercicio` | Ordem em que o exercício foi realmente iniciado na sessão. |
| Sessão livre | `plano_id` vazio, descanso padrão. Não tem fim automático: termina sempre por *Encerrar* (`encerramento = manual`). |
| Exercício pulado | Não impede o fim automático quando o resto do plano foi concluído. |
| Datas | Gravadas como texto ISO 8601 com fuso (`2026-10-20T07:30:00-03:00`). As colunas de data e de ID usam formato texto, para o Sheets não converter. |
| Segurança | O token vai na query do GET e no corpo do POST, e é comparado com as Script Properties. Valores começando com `=` são gravados como texto. |

## Limitações conhecidas

- **iPhone:** o Safari não vibra. Com a tela bloqueada, o iOS também suspende o áudio, e o alerta só toca com a tela ligada. Por isso o app mantém a tela acesa (Wake Lock) durante o treino.
- **Abrir sem rede:** não funciona, porque não há service worker (RT-15). Uma vez aberto, o treino inteiro roda offline.
- **Cache do histórico:** o app guarda as últimas 5 sessões de cada exercício (`historico_sessoes` na aba Config). Os recordes são calculados sobre todo o histórico.
- **Editar a planilha à mão:** fique à vontade, mas não altere a primeira coluna (ID). O app baixa os dados novos ao abrir, desde que não haja envios pendentes.
