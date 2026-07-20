; Hook customizado do instalador NSIS gerado pelo electron-builder (macro `customUnInstall`,
; chamada dentro da seção de desinstalação). Pergunta se o usuário quer apagar também os
; dados locais (banco de dados, backups, imagens, configurações) — tudo vive em
; `%APPDATA%\kivo` (ver `app.getPath('userData')`, sem `app.setName()` customizado, resolve
; do `name` do package.json). Resposta padrão é "Não" (MB_DEFBUTTON2): desinstalar não deve
; apagar dados de negócio sem uma escolha consciente do usuário.
!macro customUnInstall
  MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 \
    "Deseja também remover TODOS os dados do Kivo nesta máquina (banco de dados, backups, imagens de produtos e configurações)?$\r$\n$\r$\nEsta ação não pode ser desfeita. Se você pretende reinstalar depois ou ainda não tem certeza, escolha Não." \
    IDYES kivo_remove_data IDNO kivo_keep_data
  kivo_remove_data:
    RMDir /r "$APPDATA\kivo"
  kivo_keep_data:
!macroend
