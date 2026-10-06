; Hook customizado do instalador NSIS gerado pelo electron-builder.
;
; ─────────────────────────────────────────────────────────────────────────────
; 1) `customCheckAppRunning` — encerra o Kivo que estiver aberto ANTES de instalar.
;
; POR QUE ELE EXISTE (e por que a versao anterior dele era pior):
;
; O comportamento PADRAO do electron-builder (`_CHECK_APP_RUNNING`) chama
; `${GetProcessInfo}`, que usa `System::Call` + `NtQuerySystemInformation` com as
; estruturas de offset fixo do plugin do NSIS. Nesta build do Windows (10.0.26200)
; isso le lixo e estoura com EXCEPTION_ACCESS_VIOLATION dentro de `System.dll`
; (ha minidumps em %LOCALAPPDATA%\CrashDumps desde a 0.3.1), e o efeito pratico e
; um destes dois: o instalador fecha sozinho no meio, ou fica preso na caixa
; "Nao e possivel fechar o Kivo" mesmo com o app ja encerrado.
;
; A versao ANTERIOR deste macro tentava contornar isso com
; `nsExec::Exec` + `tasklist` + cmd/capture de saida. Foi removida porque
; `nsExec::Exec` BLOQUEIA esperando o comando terminar e, se ele nao retorna,
; o instalador trava indefinidamente sem janela e sem progresso.
;
; Esta versao nao captura saida e nao depende de comando externo:
;   * `taskkill /F /IM` e um executavel do proprio Windows, sempre retorna;
;   * despachado por `Exec` (assincrono), o instalador NAO espera por ele;
;   * se nao houver processo, o `taskkill` apenas imprime "nao encontrado" e sai —
;     nao ha caixa, nao ha laco, nao ha travamento;
;   * a unica espera e um `Sleep` fixo, que sempre termina.
;
; Encerrar a forca e proposital: o Kivo com erro de boot fica sem janela
; respondendo, e um fechamento educado nunca funcionaria nesse caso.
!macro customCheckAppRunning
  DetailPrint `Encerrando instancias do ${PRODUCT_NAME} em execucao...`
  Exec `"$SYSDIR\taskkill.exe" /F /IM "${APP_EXECUTABLE_FILENAME}" /T`
  Sleep 2500
!macroend

; ─────────────────────────────────────────────────────────────────────────────
; 1b) `customInit` — encerra o Kivo e limpa a pasta ANTES da secao de instalacao.
;
; POR QUE ELE EXISTE (o sintoma que ele resolve):
;
; A caixa "Nao e possivel fechar o Kivo. Feche a janela do Kivo e clique em Repetir"
; aparece por volta de ~70% da instalacao, e vem de `extractAppPackage.nsh`: na
; extracao o electron-builder copia o app para a pasta de instalacao com `CopyFiles`;
; se QUALQUER arquivo de destino estiver em uso (um Kivo.exe aberto ou orfao sem
; janela) ou a pasta tiver residuo de uma tentativa anterior, o `CopyFiles` falha,
; ele tenta 5x e mostra essa caixa — mesmo quando "nao ha nada aberto".
;
; Este macro roda em `.onInit` (macros `customInit` rodam SO no instalador, nunca no
; desinstalador) e deixa o terreno limpo antes de extrair:
;   1. encerra qualquer Kivo.exe — inclusive processo orfao sem janela;
;   2. apaga a pasta de instalacao (a padrao `$INSTDIR` e a registrada);
;   3. apaga as chaves do app e do Painel de Controle, para o `uninstallOldVersion`
;      tambem nao tentar rodar o desinstalador antigo quebrado da 2.0.8.
;
; Assim a extracao escreve numa pasta vazia e sem processo segurando arquivo: sem
; laco e sem caixa. Isto NAO toca em `%APPDATA%\Kivo` (banco, backups, imagens e
; configuracoes continuam intactos): remove apenas os binarios e o registro do app.
!macro customInit
  ; Mata em duas rodadas: a primeira derruba o Kivo; a segunda pega qualquer filho
  ; que tenha reaberto e garante que os handles dos arquivos sejam liberados antes
  ; da extracao comecar.
  Exec `"$SYSDIR\taskkill.exe" /F /IM "${APP_EXECUTABLE_FILENAME}" /T`
  Sleep 2000
  Exec `"$SYSDIR\taskkill.exe" /F /IM "${APP_EXECUTABLE_FILENAME}" /T`
  Sleep 2000

  ; Pasta padrao (`$INSTDIR`, ja definido por `initMultiUser`) — exista ou nao registro.
  RMDir /r "$INSTDIR"

  ; Pasta registrada por uma instalacao anterior (pode ser um caminho diferente).
  ReadRegStr $R0 HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
  ${If} $R0 != ""
  ${AndIf} $R0 != "$INSTDIR"
    RMDir /r "$R0"
  ${EndIf}
  ReadRegStr $R1 HKLM "${INSTALL_REGISTRY_KEY}" InstallLocation
  ${If} $R1 != ""
  ${AndIf} $R1 != "$INSTDIR"
    RMDir /r "$R1"
  ${EndIf}

  DeleteRegKey HKCU "${INSTALL_REGISTRY_KEY}"
  DeleteRegKey HKCU "${UNINSTALL_REGISTRY_KEY}"
  DeleteRegKey HKLM "${INSTALL_REGISTRY_KEY}"
  DeleteRegKey HKLM "${UNINSTALL_REGISTRY_KEY}"
!macroend

; ─────────────────────────────────────────────────────────────────────────────
; 2) `customUnInstallCheck` / `customUnInstallCheckCurrentUser` — tolera o
;    desinstalador da versao ANTIGA que FALHA.
;
; POR QUE ELE EXISTE:
;
; Numa atualizacao o instalador chama o desinstalador da versao anterior com
; `ExecWait` (ver `installUtil.nsh` -> `uninstallOldVersion`). Se esse
; desinstalador sair com codigo != 0, o electron-builder cai no
; `handleUninstallResult` e mostra a caixa "uninstallFailed" — em modo silencioso
; ela trava a instalacao sem janela, e em modo normal o lojista ve um erro e a
; instalacao nao conclui ("o 2.1.1 nao instala").
;
; A 2.0.8 JA INSTALADA tem esse defeito: o desinstalador dela usa o
; `GetProcessInfo` padrao do electron-builder, que le lixo no Windows 10.0.26200
; e retorna erro. Nao ha como corrigir um binario que ja esta gravado na maquina
; do cliente — entao o instalador NOVO precisa ignorar essa falha e seguir.
;
; Definir estes dois macros faz o electron-builder `Return` ANTES da caixa de
; erro, e a instalacao continua sobrescrevendo os arquivos. E seguro porque o
; `customCheckAppRunning` acima ja encerrou o Kivo em execucao (nao ha arquivo
; em uso). Os dois nomes cobrem instalacao por-usuario (`customUnInstallCheck`)
; e por-maquina/outro usuario (`customUnInstallCheckCurrentUser`).
!macro customUnInstallCheck
  DetailPrint `Desinstalador da versao anterior falhou; seguindo com a instalacao.`
!macroend

!macro customUnInstallCheckCurrentUser
  DetailPrint `Desinstalador (usuario atual) da versao anterior falhou; seguindo com a instalacao.`
!macroend

; A pergunta sobre apagar os dados locais (banco, backups, imagens, configurações — tudo em
; `%APPDATA%\kivo`, ver `app.getPath('userData')`) é feita SOMENTE numa desinstalação de
; verdade. Durante uma ATUALIZAÇÃO o instalador roda a desinstalação da versão anterior em
; silêncio (com a flag `--updated`), e um clique acidental em "Sim" apagaria os dados da loja
; no meio do processo. Por isso o bloco é ignorado quando `${isUpdated}` é verdadeiro.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 \
      "Deseja também remover TODOS os dados do Kivo nesta máquina (banco de dados, backups, imagens de produtos e configurações)?$\r$\n$\r$\nEsta ação não pode ser desfeita. Se você pretende reinstalar depois ou ainda não tem certeza, escolha Não." \
      IDYES kivo_remove_data IDNO kivo_keep_data
    kivo_remove_data:
      RMDir /r "$APPDATA\kivo"
    kivo_keep_data:
  ${endif}
!macroend
