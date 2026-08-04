# VoxLab — Fábrica de Documentários estilo Vox

Plataforma 100% gratuita que gera vídeos documentais no estilo Vox (colagem editorial)
direto no navegador — funciona em celular e computador.

## Como funciona
1. Você digita o tema → o Gemini pesquisa fatos na web e escreve o roteiro (fórmula Vox).
2. As imagens vêm de fotos históricas reais (Wikimedia Commons, domínio público) ou são
   geradas por IA (Nano Banana / Gemini) se você ligar "Imagens IA".
3. A narração é gerada pelo TTS do Gemini (vozes de documentário).
4. O **motor de animação próprio** (Canvas) anima tudo no estilo Vox: recortes de papel,
   alfinetes, fita adesiva, círculos de marcador, tipografia gigante, gráficos, rotas.
5. A trilha sonora (pulso grave a 46 BPM + whooshes de papel) é sintetizada em WebAudio.
6. O vídeo final (MP4 ou WebM) é gravado e baixado direto do navegador. Custo: R$ 0.

## Requisito único
Uma chave gratuita da API Gemini: https://aistudio.google.com/apikey
Cole em ⚙️ Configurações. O free tier permite ~1-2 vídeos completos por dia.

## Rodar localmente
```
node server.js
# abre http://localhost:8734
```

## Publicar grátis (acessar de qualquer lugar)
Opção mais simples — GitHub Pages (5 min, sem terminal):
1. Crie um repositório em github.com (ex.: `voxlab`).
2. Arraste os arquivos `index.html`, `style.css`, `app.js` para o repositório pelo site.
3. Em Settings → Pages → Branch `main` → Save.
4. Seu app fica em `https://SEUUSUARIO.github.io/voxlab` — abra no celular e adicione à tela inicial.

## Estrutura
- `index.html` — interface (mobile-first)
- `style.css` — visual editorial (papel, amarelo, navy, coral)
- `app.js` — pipeline (pesquisa → roteiro → imagens → voz → render) + motor de animação
- `server.js` — servidor local de testes (não é necessário em produção; o app é 100% estático)

## Estilos
A arquitetura é plugável: cada estilo é um conjunto de cenas do renderer.
Hoje: **Colagem Editorial (Vox)**. Próximos: Diorama de Papel, e o que você quiser.
