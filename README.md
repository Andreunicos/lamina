# Lâmina

Uma barra lateral de vidro fosco para o Windows. Fica escondida como uma alça fina na borda da tela e abre com um clique ou com **Ctrl + Alt + Espaço**.

## O que tem dentro

- **Início:** relógio, busca única (apps, perguntar à IA, tocar música, salvar nota), apps abertos há pouco, últimas mensagens do WhatsApp e notas recentes.
- **Apps:** todos os apps do Menu Iniciar, inclusive os da Microsoft Store. Digite e aperte Enter.
- **WhatsApp:** o WhatsApp Web dentro da barra. As mensagens novas aparecem no Início e a alça fica âmbar quando há não lidas.
- **Música:** YouTube Music. Digite o nome e Enter já toca o primeiro resultado. O Início ganha controles de tocar, pausar e pular.
- **ChatGPT e Gemini:** os sites oficiais, usando a sua conta gratuita. Pela busca do Início, `gpt sua pergunta` ou `gem sua pergunta` já envia a pergunta.
- **Notas:** bloco de notas com salvamento automático. A primeira linha vira o título.
- **Ajustes:** lado da tela, atalho, abrir ao passar o mouse, recolher ao clicar fora, iniciar com o Windows, tipo de vidro e atualizações.

### Comandos da busca

| Digite | Faz |
| --- | --- |
| `nome do app` | abre o app |
| `gpt ...` ou `chat ...` | pergunta ao ChatGPT |
| `gem ...` | pergunta ao Gemini |
| `tocar ...` ou `m ...` | toca no YouTube Music |
| `nota ...` | salva uma nota |

Atalhos dentro da barra: `Ctrl+1` a `Ctrl+7` trocam de seção, `Ctrl+N` cria nota, `Esc` recolhe.

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

- O login com Google dentro de apps às vezes é bloqueado pelo Google ("navegador não seguro"). Se acontecer, entre com e-mail e senha no próprio site, ou use o botão de abrir no navegador.
- Tocar o primeiro resultado e enviar a pergunta ao Gemini automaticamente dependem do layout atual desses sites. Se eles mudarem o layout, pode ser preciso ajustar os seletores em `src/renderer/app.js`.

## Créditos

Fontes Chakra Petch e Hanken Grotesk, licença SIL Open Font License 1.1 (arquivos em `src/renderer/fonts`).
