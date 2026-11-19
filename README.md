# Lâmina

Uma barra lateral de vidro fosco para o Windows. Fica escondida como uma alça fina na borda da tela e abre com um clique ou com **Alt + aspas** (a tecla `'` ao lado do 1 no teclado ABNT2).

## O que tem dentro

- **Início:** relógio, busca única (apps, perguntar à IA, tocar música, salvar nota), apps abertos há pouco, últimas mensagens do WhatsApp e notas recentes.
- **Apps:** todos os apps do Menu Iniciar, inclusive os da Microsoft Store. Digite e aperte Enter.
- **WhatsApp:** o WhatsApp Web dentro da barra. As mensagens novas aparecem no Início e a alça fica âmbar quando há não lidas.
- **Música:** YouTube Music. Digite o nome e Enter já toca o primeiro resultado. O Início ganha controles de tocar, pausar e pular.
- **Steam:** duas abas. **Amigos** é o chat da Steam (quem está online, jogando o quê, e conversar). **Jogos** mostra os jogos instalados com as capas, os jogados por último primeiro. Clique e o jogo abre. Atalhos para Biblioteca, Loja, Amigos e Downloads. Os últimos jogados também aparecem no Início, e a busca do Início acha jogos pelo nome.
- **ChatGPT e Gemini:** os sites oficiais, usando a sua conta gratuita. Pela busca do Início, `gpt sua pergunta` ou `gem sua pergunta` já envia a pergunta.
- **Notas:** bloco de notas com salvamento automático. A primeira linha vira o título. Aceita imagens: cole com Ctrl+V (inclusive prints do Win+Shift+S) ou arraste um arquivo. Passe o mouse na imagem para **Copiar** (vai para a área de transferência, é só colar em outro app) ou **Salvar…** como PNG. Também dá para arrastar a imagem da nota direto para o Discord, WhatsApp ou uma pasta. Colar uma imagem na busca do Início guarda ela numa nota nova.
- **Discord:** o Discord dentro da barra. As mensagens novas aparecem no Início como as do WhatsApp.
- **Notas rápidas para o Obsidian:** na aba Notas, escreva e mande direto pro cofre que você escolher. Vai como um arquivo .md (na pasta Inbox do cofre, se existir, senão na raiz). Os cofres vêm da sua própria instalação do Obsidian.
- **Transferência:** histórico do que você copia (textos e imagens). Clique num item para copiá-lo de novo. Dá para remover um item ou limpar tudo. Fica só neste computador.
- **Tempo:** cronômetro rápido (5, 10, 15, 25, 45 min, 1 h ou personalizado) e Pomodoro (25 de foco / 5 de pausa, pausa de 15 a cada 4 focos). Avisa com som e notificação quando termina, mesmo com a barra recolhida.
- **Sistema (no Início):** uso de CPU, memória e GPU ao vivo. Temperatura e uso da GPU aparecem quando há placa NVIDIA (via nvidia-smi).
- **Ajustes:** lado da tela, atalho, abrir ao passar o mouse, recolher ao clicar fora, iniciar com o Windows, **modo imersivo**, histórico da área de transferência, memória (dormir ao recolher, segundo plano, descarte por inatividade, modo de eficiência, otimizar sites em segundo plano, bloquear rastreadores, continuar tocando música ao recolher, liberar memória agora), tipo de vidro e atualizações.

**Memória:** por padrão, quando a barra recolhe, ela "dorme" e fecha os processos das abas (cada aba é um processo do Chromium, a maior parte da RAM), liberando a memória e chegando perto do piso do Electron. Além de fechar as abas, ao recolher ela também limpa os caches de rede das sessões, compacta o heap do processo principal e, no Windows, encolhe o working set de todos os processos (`EmptyWorkingSet`) — tudo sem deslogar ninguém (só o cache é apagado; cookies e login continuam salvos). Com a barra recolhida, o relógio, os feeds e o "tocando agora" param de atualizar, então o consumo de CPU parado também cai para perto de zero; só o timer/Pomodoro continua contando. Ao abrir de novo, a aba recarrega em segundos e as contas continuam logadas. WhatsApp e Discord ficam ligados em segundo plano só enquanto a barra está aberta, para alimentar as mensagens no Início; dá para desligar isso nos Ajustes.

**Descarte por inatividade:** mesmo com a barra aberta, uma aba parada há mais de N minutos é descarregada sozinha e recriada quando você voltar a ela. O tempo é configurável em **Ajustes → Memória → Descartar aba parada há** (5, 10, 15, 30 min ou **Nunca**; padrão 15). Revisitar a aba dentro desse tempo é instantâneo (ela fica "quente"). WhatsApp e Discord não são descartados enquanto estiverem alimentando o Início.

**Segundo plano de verdade:** abas que não estão à vista ficam com `display:none`, então o Chromium as marca como ocultas, liga o `backgroundThrottling` (timers caem para ~1/min) e o V8/PartitionAlloc devolvem RAM uns segundos depois.

**Modo de eficiência (EcoQoS):** no Windows, com a barra recolhida, os renderers das abas entram em EcoQoS (`SetProcessInformation` + `PROCESS_POWER_THROTTLING_EXECUTION_SPEED`) — rodam nos núcleos de baixo consumo, poupando CPU/energia. Volta ao normal ao abrir. Dá para desligar nos Ajustes.

**Liberar memória agora:** botão em **Ajustes → Memória** que, na hora, limpa os caches das seis partições, compacta o heap e encolhe o working set de todos os processos (Windows).

### Otimizações de sites em segundo plano

Três interruptores novos em **Ajustes → Memória** (todos ligados por padrão):

- **Otimizar sites em segundo plano** (`leanWebviews`): desliga o autoplay (reprodução só começa com um toque seu), congela a animação de GIFs/imagens e injeta um CSS que encurta animações e transições das páginas (no idioma do `prefers-reduced-motion`, sem quebrar os sites). Com a barra aberta, abas ociosas e ocultas também recebem uma purga de memória via CDP do Chromium (`HeapProfiler.collectGarbage` + `Memory.forciblyPurgeJavaScriptMemory`). **Importante:** essa purga só atinge abas de baixo risco (Música, ChatGPT, Gemini, chat da Steam) — **WhatsApp e Discord nunca são purgados**, e a aba de Música **nunca é purgada enquanto o áudio estiver tocando**. Não há congelamento de ciclo de vida (`frozen`), de propósito, para não travar aba.
- **Bloquear rastreadores e telemetria** (`blockTrackers`): cancela as requisições para uma lista pequena, curada e embutida de rastreadores/telemetria de **terceiros** (Segment, Amplitude, Mixpanel, Hotjar, FullStory, Sentry, New Relic, Datadog RUM, Clarity, etc.). **Não** bloqueia anúncios (o YouTube Music fica intacto) nem domínios de login/CDN dos próprios serviços (Google, Meta/WhatsApp, Microsoft, Discord, OpenAI, Steam). Nada é baixado em tempo de execução; sem dependência nova.
- **Continuar tocando música ao recolher** (`musicKeepPlaying`): ao recolher a barra com a Música tocando, mantém **só** a aba de Música de pé — oculta (`display:none`, sem render visual) mas com o áudio seguindo — enquanto todo o resto dorme. Quando você pausa ou para a música, a aba cai para o piso (é descarregada e a memória é liberada).

**Honestidade sobre o ganho:** os itens 1 a 5 economizam sobretudo **CPU e dados** (menos animação, menos autoplay, menos telemetria); o ganho de RAM é incremental. A música em segundo plano é um trade-off consciente: com ela tocando ao recolher, **um** renderer (o da Música) continua vivo — na prática uns **130–200 MB** no Windows real — oculto e sem desenhar nada na tela, com o resto do app dormindo; ao pausar/parar, ele também some e o app volta ao piso.

> As partes específicas do Windows (`EmptyWorkingSet` e EcoQoS) são feitas chamando o PowerShell, que compila um trecho de C# em runtime (`Add-Type`) e faz P/Invoke do `kernel32` — **sem nenhuma dependência nativa** (nada de node-gyp/ffi), para a build do CI não quebrar. Em outros sistemas, essas chamadas simplesmente não fazem nada.

Medir o uso de memória: `xvfb-run -a ./node_modules/.bin/electron --no-sandbox tools/measure.js [N]` reproduz o ciclo de vida das abas (abrir N abas, mandar para segundo plano, descartar por inatividade, recolher) e mostra o RSS da árvore de processos em MB. O trade-off é claro: "recolhido com zero de memória" e "reabrir instantâneo com a página já pronta" são conflitantes — a Lâmina prioriza a memória, então reabrir recarrega a página (a interface em si abre na hora, porque a janela fica pré-aquecida em segundo plano). Há também um smoke test da interface sob xvfb: `xvfb-run -a ./node_modules/.bin/electron --no-sandbox tools/smoke.js` (sai com código 0 se não houver erro de JS no renderer e todos os fluxos passarem).

**Modo imersivo:** nos Ajustes, some com a alça da borda de vez. A barra fica 100% invisível e só aparece com o atalho (Alt + aspas). Bom pra quem não quer nada na beirada da tela.

### Comandos da busca

| Digite | Faz |
| --- | --- |
| `nome do app` | abre o app |
| `gpt ...` ou `chat ...` | pergunta ao ChatGPT |
| `gem ...` | pergunta ao Gemini |
| `tocar ...` ou `m ...` | toca no YouTube Music |
| `nota ...` | salva uma nota |

Atalhos dentro da barra: `Ctrl+1` a `Ctrl+9` trocam de seção, `Ctrl+N` cria nota, `Esc` recolhe.

**Largura:** arraste a borda de dentro da barra (a que não encosta na tela) para deixar mais larga ou mais estreita. Duplo clique nela volta ao tamanho padrão. A largura fica salva.

**Tamanho das páginas:** nas abas WhatsApp, Música, ChatGPT e Gemini, as lupas com − e + diminuem ou aumentam a página (fica salvo por aba).

## Instalar

1. Abra a página de [Releases](https://github.com/Andreunicos/lamina/releases/latest) e baixe `Lamina-Setup-x.y.z.exe`.
2. Execute. Como o instalador não tem assinatura digital, o Windows pode mostrar "O Windows protegeu o computador": clique em **Mais informações → Executar assim mesmo**.
3. A Lâmina abre sozinha na borda direita da tela.

Isso só é preciso uma vez. Depois disso ela se atualiza sozinha.

## Como a atualização automática funciona

1. Todo push na branch `main` dispara o GitHub Actions (`.github/workflows/release.yml`).
2. O Actions gera o instalador no Windows e publica uma release nova com a versão `1.0.<número da execução>`.
3. A Lâmina instalada procura atualização ao abrir e a cada 30 minutos (dá para mudar nos Ajustes). Também tem o botão **Verificar atualização** nos Ajustes e no menu do ícone da bandeja.
4. Ela baixa em segundo plano e, quando a barra está recolhida, fecha e reabre já na versão nova (leva poucos segundos).

Para subir de versão "grande" (ex.: 1.1.x), mude o `version` no `package.json` para `1.1.0`.

## Vidro

- **Windows 11 22H2 ou mais novo:** usa o desfoque Acrylic do próprio Windows. O fundo atrás da barra fica borrado de verdade.
- **Windows 10:** usa o vidro simulado (escuro translúcido, sem desfoque), porque o Windows 10 não oferece esse desfoque para apps.

Dá para trocar em **Ajustes → Aparência → Vidro**.

## Desenvolvimento

```bash
npm install
npm start           # roda em modo de desenvolvimento
npm run dist        # gera o instalador em dist/ (precisa rodar no Windows)
```

Estrutura:

```
src/main/       processo principal (janela, borda, atalho, bandeja, atualização, apps)
src/preload/    pontes seguras (barra e webview do WhatsApp)
src/renderer/   interface (HTML, CSS, JS, fontes)
```

## Privacidade

- Notas, ajustes e a lista de apps recentes ficam só neste computador, em `%APPDATA%\Lamina`.
- As mensagens do WhatsApp mostradas no Início ficam só na memória e somem quando o app fecha.
- WhatsApp, YouTube Music, ChatGPT e Gemini rodam os sites oficiais com o login de cada um. A Lâmina não lê senhas nem envia nada para servidores próprios.

## Limitações conhecidas

- O Google bloqueia login dentro de apps feitos com Chromium ("Esse navegador ou app pode não ser seguro"). A Lâmina se identifica como Firefox só nas páginas de login do Google, o que normalmente resolve. Se o Google mudar a regra e voltar a bloquear, no ChatGPT dá para entrar com e-mail e senha.
- Tocar o primeiro resultado e enviar a pergunta ao Gemini automaticamente dependem do layout atual desses sites. Se eles mudarem o layout, pode ser preciso ajustar os seletores em `src/renderer/app.js`.

## Créditos

Fontes Chakra Petch e Hanken Grotesk, licença SIL Open Font License 1.1 (arquivos em `src/renderer/fonts`).
