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
o segredo. Com endereço fixo e público, o nome da sala sozinho não segura
ninguém. Por isso cada sala tem **senha própria, escolhida por quem cria**:
o primeiro a entrar num nome de sala define a senha dali, e quem chegar depois
precisa dar a mesma. Em branco = sala aberta.

A senha morre com a sala: esvaziou, some. Da próxima vez, quem chegar primeiro
escolhe de novo — inclusive outra pessoa. Não é conta, é tranca de porta.

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

### 3. Pronto

Mande pra galera o endereço. Combinem entre vocês o nome da sala e a senha —
não tem nada pra configurar no painel.

Quem chega primeiro cria a sala e a senha dela. Quem vem depois digita as duas
iguais. Se alguém errar o nome da sala, o app avisa na tela: "Você criou a sala
X" — é assim que se percebe que a pessoa está sozinha numa sala com nome
errado, em vez de ficar esperando achando que os outros vão chegar.

Senha em branco funciona, mas num endereço público significa que qualquer um
que acerte o nome entra.

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

Nada disso quebra o `Cinema.bat`: é o mesmo servidor, com ou sem hospedagem.
Em casa dá pra deixar a senha em branco — o link do túnel já é secreto e morre
com a sessão. Dá pra ter os dois: o endereço fixo pro dia a dia, a pasta
portátil pra quando o Render estiver fora do ar.

## Variáveis de ambiente

| Variável | Padrão | Pra que serve |
|---|---|---|
| `PORT` | 3000 | O Render define sozinho. Não mexa. |
| `MAX_PEERS` | 4 | Quantas pessoas cabem numa sala. |
| `MAX_ROOMS` | 20 | Teto de salas abertas ao mesmo tempo. |
| `TURN_URL` | *(vazio)* | `turn:host:3478`, se você tiver um TURN. |
| `TURN_USER` | *(vazio)* | Usuário do TURN. |
| `TURN_PASS` | *(vazio)* | Senha do TURN. |
