# Cinema num endereço fixo (Render)

Hoje o Cinema depende do seu PC ligado: o `Cinema.bat` sobe o servidor e o
cloudflared cria um link novo a cada vez. Hospedando, o endereço passa a ser
fixo (`https://alguma-coisa.onrender.com`), ninguém precisa deixar máquina
ligada, e o link nunca mais muda.

## O que muda e o que não muda

**Não muda:** o vídeo, o áudio do filme e as vozes continuam indo **direto de
um computador pro outro** (WebRTC). O Render não vê nem retransmite nada
disso. Ele só entrega a página e passa os recadinhos de conexão — alguns KB
por sessão. É por isso que o plano gratuito dá conta com folga.

**Muda a segurança.** Hoje o link é aleatório e morre com a sessão: o link *é*
o segredo. Com endereço fixo e público, o único segredo seria o nome da sala.
Por isso o servidor agora aceita uma **senha da casa** (variável de ambiente
`SENHA`). O `render.yaml` já pede pro Render gerar uma. Sem ela, qualquer
pessoa que descubra o endereço entra numa sala só acertando o nome.

## Passo a passo

### 1. Repositório

O Render puxa de um repositório Git. Na pasta do projeto:

```bash
git init -b main
```

```bash
git add . && git commit -m "Cinema: sala com voz"
```

O `.gitignore` já deixa de fora `arquivos/bin/` (os 142 MB de Node e
cloudflared, que só servem pra versão portátil) e `node_modules`.

Crie um repositório **privado** no GitHub e envie:

```bash
git remote add origin https://github.com/SEU-USUARIO/cinema.git && git push -u origin main
```

### 2. Render

1. <https://dashboard.render.com> → **New** → **Blueprint**
2. Aponte pro repositório. Ele lê o `render.yaml` sozinho e já vem com
   `rootDir: arquivos`, build, start e health check configurados.
3. **Apply**. O primeiro deploy leva uns 2 minutos.

### 3. Pegue a senha

No serviço criado → aba **Environment** → variável `SENHA`. O Render gerou um
valor aleatório; clique pra revelar e copie.

Se preferir uma senha que dê pra ditar no WhatsApp, edite ali mesmo e salve —
o serviço reinicia sozinho. Use algo longo: quem tiver o endereço pode tentar
adivinhar. Três ou quatro palavras aleatórias resolvem.

### 4. Pronto

Mande pra galera o endereço e a senha. Todo mundo digita o mesmo nome de sala,
a mesma senha, e entra.

## O incômodo do plano gratuito

Serviço free do Render **dorme depois de 15 minutos sem ninguém acessando**.
A primeira pessoa a abrir o link espera uns **50 segundos** na tela branca
enquanto ele acorda. Depois disso fica rápido pra todo mundo.

Duas saídas:

- **Aceitar.** Combine de abrir o link 1 minuto antes do filme.
- **Manter acordado.** Um serviço gratuito de monitoramento (UptimeRobot e
  afins) batendo em `https://SEU-ENDERECO.onrender.com/config` a cada 10
  minutos. O plano free dá 750 horas/mês e o mês tem 744 — cabe um serviço
  ligado 24/7, desde que seja **só um**.

## O que hospedar NÃO resolve

**NAT restritivo.** Se dois participantes estão atrás de NAT simétrico (comum
em internet móvel), a conexão direta não fecha e aparece "Conexão com Fulano
falhou". Isso precisa de um servidor **TURN**, que é outra coisa — e TURN
retransmite mídia de verdade, então gasta banda a sério. O servidor já aceita
as variáveis `TURN_URL`, `TURN_USER` e `TURN_PASS` se um dia você contratar um.

**Banda de quem transmite.** Continua sendo o gargalo: com 4 pessoas, quem
passa o filme sobe 3 cópias do vídeo.

## A versão portátil continua funcionando

Nada disso quebra o `Cinema.bat`. Sem a variável `SENHA` o campo de senha nem
aparece, e o painel com cloudflared segue igual. Dá pra ter os dois: o
endereço fixo pro dia a dia, a pasta portátil pra quando o Render estiver fora
do ar.

## Variáveis de ambiente

| Variável | Padrão | Pra que serve |
|---|---|---|
| `PORT` | 3000 | O Render define sozinho. Não mexa. |
| `SENHA` | *(vazio)* | Senha da casa. Vazio = sem senha. |
| `MAX_PEERS` | 4 | Quantas pessoas cabem numa sala. |
| `TURN_URL` | *(vazio)* | `turn:host:3478`, se você tiver um TURN. |
| `TURN_USER` | *(vazio)* | Usuário do TURN. |
| `TURN_PASS` | *(vazio)* | Senha do TURN. |
