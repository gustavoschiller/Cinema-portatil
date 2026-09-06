# Cinema - painel grafico: sobe servidor + tunel e mostra o link
$ErrorActionPreference = 'Stop'
$raiz = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $raiz

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

$porta = 3000
$script:server = $null
$script:tunel = $null
$script:link = ''
$script:node = $null
$script:cf = $null

# ---------- cores ----------
$cFundo   = [System.Drawing.Color]::FromArgb(15, 16, 21)
$cCartao  = [System.Drawing.Color]::FromArgb(26, 28, 36)
$cTexto   = [System.Drawing.Color]::FromArgb(233, 236, 241)
$cFraco   = [System.Drawing.Color]::FromArgb(139, 147, 167)
$cAccent  = [System.Drawing.Color]::FromArgb(224, 83, 61)
$cVerde   = [System.Drawing.Color]::FromArgb(84, 196, 128)
$cAmarelo = [System.Drawing.Color]::FromArgb(224, 178, 74)

function Fonte($tam, $estilo = 'Regular') {
    New-Object System.Drawing.Font('Segoe UI', $tam, [System.Drawing.FontStyle]::$estilo)
}

# ---------- janela ----------
$form = New-Object System.Windows.Forms.Form
$form.Text = 'Cinema'
$form.Size = New-Object System.Drawing.Size(560, 470)
$form.StartPosition = 'CenterScreen'
$form.BackColor = $cFundo
$form.ForeColor = $cTexto
$form.Font = Fonte 9
$form.FormBorderStyle = 'FixedSingle'
$form.MaximizeBox = $false

$pipoca = New-Object System.Windows.Forms.Label
$pipoca.Text = [char]::ConvertFromUtf32(0x1F37F)   # pipoca
$pipoca.Font = New-Object System.Drawing.Font('Segoe UI Emoji', 15)
$pipoca.Location = New-Object System.Drawing.Point(22, 20)
$pipoca.Size = New-Object System.Drawing.Size(34, 32)
$form.Controls.Add($pipoca)

$titulo = New-Object System.Windows.Forms.Label
$titulo.Text = 'Cinema'
$titulo.Font = Fonte 16 'Bold'
$titulo.ForeColor = $cTexto
$titulo.Location = New-Object System.Drawing.Point(58, 18)
$titulo.Size = New-Object System.Drawing.Size(240, 34)
$form.Controls.Add($titulo)

# ---------- status ----------
$lblStatus = New-Object System.Windows.Forms.Label
$lblStatus.Text = 'iniciando...'
$lblStatus.Font = Fonte 9
$lblStatus.ForeColor = $cAmarelo
$lblStatus.TextAlign = 'MiddleRight'
$lblStatus.Location = New-Object System.Drawing.Point(280, 26)
$lblStatus.Size = New-Object System.Drawing.Size(240, 20)
$form.Controls.Add($lblStatus)

# ---------- cartao do link dela ----------
$painelLink = New-Object System.Windows.Forms.Panel
$painelLink.BackColor = $cCartao
$painelLink.Location = New-Object System.Drawing.Point(24, 66)
$painelLink.Size = New-Object System.Drawing.Size(496, 132)
$form.Controls.Add($painelLink)

$lblParaEla = New-Object System.Windows.Forms.Label
$lblParaEla.Text = 'MANDE ESTE LINK PRA GALERA'
$lblParaEla.Font = Fonte 8 'Bold'
$lblParaEla.ForeColor = $cFraco
$lblParaEla.Location = New-Object System.Drawing.Point(16, 14)
$lblParaEla.Size = New-Object System.Drawing.Size(300, 18)
$painelLink.Controls.Add($lblParaEla)

$txtLink = New-Object System.Windows.Forms.TextBox
$txtLink.Text = 'gerando o link...'
$txtLink.Font = Fonte 10
$txtLink.ReadOnly = $true
$txtLink.BackColor = [System.Drawing.Color]::FromArgb(11, 12, 16)
$txtLink.ForeColor = [System.Drawing.Color]::FromArgb(120, 200, 255)
$txtLink.BorderStyle = 'FixedSingle'
$txtLink.Location = New-Object System.Drawing.Point(16, 38)
$txtLink.Size = New-Object System.Drawing.Size(464, 26)
$painelLink.Controls.Add($txtLink)

$btnCopiar = New-Object System.Windows.Forms.Button
$btnCopiar.Text = 'Copiar link'
$btnCopiar.Font = Fonte 9 'Bold'
$btnCopiar.FlatStyle = 'Flat'
$btnCopiar.BackColor = $cAccent
$btnCopiar.ForeColor = [System.Drawing.Color]::White
$btnCopiar.FlatAppearance.BorderSize = 0
$btnCopiar.Location = New-Object System.Drawing.Point(16, 78)
$btnCopiar.Size = New-Object System.Drawing.Size(130, 36)
$btnCopiar.Enabled = $false
$painelLink.Controls.Add($btnCopiar)

$lblCopiado = New-Object System.Windows.Forms.Label
$lblCopiado.Text = ''
$lblCopiado.Font = Fonte 9
$lblCopiado.ForeColor = $cVerde
$lblCopiado.Location = New-Object System.Drawing.Point(158, 88)
$lblCopiado.Size = New-Object System.Drawing.Size(320, 20)
$painelLink.Controls.Add($lblCopiado)

# ---------- cartao do host ----------
$painelHost = New-Object System.Windows.Forms.Panel
$painelHost.BackColor = $cCartao
$painelHost.Location = New-Object System.Drawing.Point(24, 208)
$painelHost.Size = New-Object System.Drawing.Size(496, 78)
$form.Controls.Add($painelHost)

$lblParaVoce = New-Object System.Windows.Forms.Label
$lblParaVoce.Text = "VOCE ABRE AQUI  ·  http://localhost:$porta"
$lblParaVoce.Font = Fonte 8 'Bold'
$lblParaVoce.ForeColor = $cFraco
$lblParaVoce.Location = New-Object System.Drawing.Point(16, 14)
$lblParaVoce.Size = New-Object System.Drawing.Size(360, 18)
$painelHost.Controls.Add($lblParaVoce)

$btnAbrir = New-Object System.Windows.Forms.Button
$btnAbrir.Text = 'Abrir pra mim'
$btnAbrir.Font = Fonte 9 'Bold'
$btnAbrir.FlatStyle = 'Flat'
$btnAbrir.BackColor = [System.Drawing.Color]::FromArgb(40, 44, 56)
$btnAbrir.ForeColor = $cTexto
$btnAbrir.FlatAppearance.BorderSize = 0
$btnAbrir.Location = New-Object System.Drawing.Point(16, 34)
$btnAbrir.Size = New-Object System.Drawing.Size(130, 32)
$btnAbrir.Enabled = $false
$painelHost.Controls.Add($btnAbrir)

$lblDica = New-Object System.Windows.Forms.Label
$lblDica.Text = 'Mesmo nome de sala pra todo mundo. Ate 4 pessoas.' + [Environment]::NewLine +
                'Quem passa o filme: "Guia do Chrome" + "Compartilhar audio da guia".'
$lblDica.Font = Fonte 8
$lblDica.ForeColor = $cFraco
$lblDica.Location = New-Object System.Drawing.Point(158, 34)
$lblDica.Size = New-Object System.Drawing.Size(330, 34)
$painelHost.Controls.Add($lblDica)

# ---------- log ----------
$txtLog = New-Object System.Windows.Forms.TextBox
$txtLog.Multiline = $true
$txtLog.ReadOnly = $true
$txtLog.ScrollBars = 'Vertical'
$txtLog.Font = New-Object System.Drawing.Font('Consolas', 8)
$txtLog.BackColor = [System.Drawing.Color]::FromArgb(11, 12, 16)
$txtLog.ForeColor = $cFraco
$txtLog.BorderStyle = 'FixedSingle'
$txtLog.Location = New-Object System.Drawing.Point(24, 296)
$txtLog.Size = New-Object System.Drawing.Size(496, 88)
$form.Controls.Add($txtLog)

$btnEncerrar = New-Object System.Windows.Forms.Button
$btnEncerrar.Text = 'Encerrar tudo'
$btnEncerrar.Font = Fonte 9
$btnEncerrar.FlatStyle = 'Flat'
$btnEncerrar.BackColor = [System.Drawing.Color]::FromArgb(40, 44, 56)
$btnEncerrar.ForeColor = $cTexto
$btnEncerrar.FlatAppearance.BorderSize = 0
$btnEncerrar.Location = New-Object System.Drawing.Point(390, 394)
$btnEncerrar.Size = New-Object System.Drawing.Size(130, 32)
$form.Controls.Add($btnEncerrar)

# ---------- helpers ----------
function Log($t) {
    $txtLog.AppendText((Get-Date -Format 'HH:mm:ss') + '  ' + $t + [Environment]::NewLine)
    [System.Windows.Forms.Application]::DoEvents()
}

function Status($t, $cor) {
    $lblStatus.Text = $t
    $lblStatus.ForeColor = $cor
    [System.Windows.Forms.Application]::DoEvents()
}

function Espera($ms) {
    $fim = (Get-Date).AddMilliseconds($ms)
    while ((Get-Date) -lt $fim) {
        [System.Windows.Forms.Application]::DoEvents()
        Start-Sleep -Milliseconds 40
    }
}

function Porta-Ativa {
    [bool](Get-NetTCPConnection -LocalPort $porta -State Listen -ErrorAction SilentlyContinue)
}

function Subir-Servidor {
    $p = Start-Process -FilePath $script:node -ArgumentList 'server.js' `
        -WorkingDirectory $raiz -WindowStyle Minimized -PassThru
    foreach ($i in 1..40) {
        Espera 400
        try {
            Invoke-WebRequest "http://localhost:$porta/" -UseBasicParsing -TimeoutSec 2 | Out-Null
            return $p
        } catch { }
    }
    return $null
}

function Subir-Tunel {
    $script:link = ''
    $logT = Join-Path $env:TEMP ("cinema-tunel-{0}.log" -f (Get-Date -Format 'yyyyMMdd-HHmmss'))
    Get-ChildItem (Join-Path $env:TEMP 'cinema-tunel-*.log') -ErrorAction SilentlyContinue |
        Remove-Item -Force -ErrorAction SilentlyContinue

    $script:tunel = Start-Process -FilePath $script:cf `
        -ArgumentList 'tunnel', '--url', "http://localhost:$porta", '--no-autoupdate', '--logfile', $logT `
        -WindowStyle Minimized -PassThru

    foreach ($i in 1..70) {
        Espera 700
        if (Test-Path $logT) {
            $texto = Get-Content $logT -Raw -ErrorAction SilentlyContinue
            if ($texto -match 'https://[a-z0-9\-]+\.trycloudflare\.com') {
                $script:link = $Matches[0]
                break
            }
        }
        if ($script:tunel.HasExited) { break }
    }

    $script:logTunel = $logT
    return [bool]$script:link
}

function Copiar {
    if (-not $script:link) { return }
    Set-Clipboard -Value $script:link
    $lblCopiado.Text = 'copiado!'
    $script:copiadoEm = Get-Date
}

$btnCopiar.Add_Click({ Copiar })
$btnAbrir.Add_Click({ Start-Process "http://localhost:$porta" })
$btnEncerrar.Add_Click({ $form.Close() })

$form.Add_FormClosing({
    Log 'encerrando...'
    foreach ($p in @($script:tunel, $script:server)) {
        if ($p -and -not $p.HasExited) {
            Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
        }
    }
})

# ---------- inicio ----------
$form.Show()
[System.Windows.Forms.Application]::DoEvents()

try {
    # node: primeiro o embutido em bin\, depois o instalado na maquina
    $embutido = Join-Path $raiz 'bin\node.exe'
    if (Test-Path $embutido) {
        $script:node = $embutido
        Log 'usando o Node embutido'
    } else {
        $n = Get-Command node -ErrorAction SilentlyContinue
        if (-not $n) {
            [System.Windows.Forms.MessageBox]::Show(
                'Node.js nao encontrado. Instale em https://nodejs.org', 'Cinema') | Out-Null
            $form.Close()
            return
        }
        $script:node = $n.Source
    }

    # cloudflared: mesma ordem
    foreach ($c in @(
        (Join-Path $raiz 'bin\cloudflared.exe'),
        (Join-Path ${env:ProgramFiles(x86)} 'cloudflared\cloudflared.exe'),
        (Join-Path $env:ProgramFiles 'cloudflared\cloudflared.exe'))) {
        if (Test-Path $c) { $script:cf = $c; break }
    }
    if (-not $script:cf) {
        $g = Get-Command cloudflared -ErrorAction SilentlyContinue
        if ($g) { $script:cf = $g.Source }
    }
    if (-not $script:cf) {
        [System.Windows.Forms.MessageBox]::Show(
            "cloudflared nao encontrado. Instale com:`n`nwinget install --id Cloudflare.cloudflared --source winget",
            'Cinema') | Out-Null
        $form.Close()
        return
    }

    if (-not (Test-Path (Join-Path $raiz 'node_modules'))) {
        if (Get-Command npm -ErrorAction SilentlyContinue) {
            Status 'instalando dependencias...' $cAmarelo
            Log 'instalando dependencias (primeira vez)...'
            npm install --no-fund --no-audit --silent
        } else {
            [System.Windows.Forms.MessageBox]::Show(
                'Faltou a pasta node_modules e nao ha npm nesta maquina.', 'Cinema') | Out-Null
            $form.Close()
            return
        }
    }

    # tunel antigo
    $velhos = Get-Process cloudflared -ErrorAction SilentlyContinue
    if ($velhos) {
        Log 'fechando tunel de execucao anterior'
        $velhos | Stop-Process -Force -ErrorAction SilentlyContinue
        Espera 500
    }

    # servidor
    if (Porta-Ativa) {
        Log "porta $porta ja em uso - reaproveitando servidor"
    } else {
        Status 'subindo servidor...' $cAmarelo
        Log 'subindo servidor'
        $script:server = Subir-Servidor
        if (-not $script:server) {
            Status 'servidor falhou' $cAccent
            Log 'ERRO: servidor nao respondeu'
            return
        }
    }
    Log 'servidor no ar'
    $btnAbrir.Enabled = $true

    # tunel
    Status 'abrindo tunel...' $cAmarelo
    Log 'abrindo tunel publico'
    ipconfig /flushdns | Out-Null

    if (-not (Subir-Tunel)) {
        Status 'tunel falhou' $cAccent
        Log ('ERRO: tunel nao subiu - veja ' + $script:logTunel)
        return
    }

    $txtLink.Text = $script:link
    $btnCopiar.Enabled = $true
    Copiar
    Log 'link pronto e copiado'

    # ela consegue resolver? (DNS publico, nao o do roteador)
    $publico = $false
    foreach ($i in 1..20) {
        try {
            $dns = Resolve-DnsName ([Uri]$script:link).Host -Server '1.1.1.1' -Type A -ErrorAction Stop
            if ($dns | Where-Object { $_.IPAddress }) { $publico = $true; break }
        } catch { }
        Espera 800
    }
    if ($publico) {
        Log 'link ja resolve no DNS publico'
    } else {
        Log 'link ainda propagando - se ela nao abrir, espere 1 min'
    }

    Start-Process "http://localhost:$porta"
    Status 'no ar' $cVerde

    # ---------- vigia ----------
    $script:copiadoEm = $null
    $proximaChecagem = (Get-Date).AddSeconds(5)

    while ($form.Visible) {
        [System.Windows.Forms.Application]::DoEvents()
        Start-Sleep -Milliseconds 80

        if ($script:copiadoEm -and ((Get-Date) - $script:copiadoEm).TotalSeconds -gt 2) {
            $lblCopiado.Text = ''
            $script:copiadoEm = $null
        }

        if ((Get-Date) -lt $proximaChecagem) { continue }
        $proximaChecagem = (Get-Date).AddSeconds(5)

        if (-not (Porta-Ativa)) {
            Status 'servidor caiu, subindo...' $cAmarelo
            Log 'servidor caiu - subindo de novo'
            $script:server = Subir-Servidor
            if ($script:server) {
                Log 'servidor no ar de novo'
                Status 'no ar' $cVerde
            } else {
                Status 'servidor nao volta' $cAccent
                Log 'ERRO: nao consegui subir o servidor'
            }
        }

        # O tunel gratuito do Cloudflare morre sozinho de vez em quando.
        # Sobe outro na hora - mas o endereco muda, entao o link antigo
        # para de funcionar e precisa ser reenviado.
        if ($script:tunel -and $script:tunel.HasExited) {
            Status 'tunel caiu, subindo outro...' $cAmarelo
            Log 'o tunel caiu - abrindo um novo'
            $txtLink.Text = 'gerando um link novo...'
            $btnCopiar.Enabled = $false
            if (Subir-Tunel) {
                $txtLink.Text = $script:link
                $btnCopiar.Enabled = $true
                Copiar
                Log 'LINK NOVO copiado - mande de novo pra galera'
                Status 'no ar (link novo)' $cVerde
            } else {
                Status 'tunel nao volta' $cAccent
                Log ('ERRO: nao consegui reabrir o tunel - veja ' + $script:logTunel)
            }
        }
    }
}
catch {
    Log ('ERRO: ' + $_.Exception.Message)
    Status 'erro' $cAccent
    [System.Windows.Forms.MessageBox]::Show($_.Exception.Message, 'Cinema - erro') | Out-Null
}
finally {
    if ($form.Visible) { $form.Close() }
    $form.Dispose()
}
