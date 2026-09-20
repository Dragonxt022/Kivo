; Hook customizado do instalador NSIS gerado pelo electron-builder (macro `customUnInstall`,
; chamada dentro da seção de desinstalação).
;
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
