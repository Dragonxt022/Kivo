@echo off
REM ============================================================================
REM  Prepara a maquina para uma instalacao LIMPA do Kuruk.
REM
REM  O que faz:
REM    1. encerra qualquer Kuruk/Kivo/instalador pendurado;
REM    2. roda o desinstalador da versao instalada, em silencio;
REM    3. apaga as pastas de instalacao (Kuruk e a antiga Kivo);
REM    4. remove as chaves de registro dos dois appIds (o atual e o legado);
REM    5. NAO toca em %APPDATA%\Kuruk nem em %APPDATA%\Kivo -> seus dados,
REM       banco e backups ficam.
REM
REM  COMO USAR: de DUPLO CLIQUE. Depois rode o instalador.
REM ============================================================================

set D=%LOCALAPPDATA%\Programs\Kuruk
set DOLD=%LOCALAPPDATA%\Programs\Kivo
set LOG=%~dp0preparar-limpeza.txt

echo Kuruk - preparacao para instalacao limpa > "%LOG%"
echo Gerado em %DATE% %TIME% >> "%LOG%"
echo. >> "%LOG%"

echo [1/5] encerrando processos do Kuruk e do Kivo >> "%LOG%"
taskkill /F /IM Kuruk.exe /T >> "%LOG%" 2>&1
taskkill /F /IM Kivo.exe /T >> "%LOG%" 2>&1
taskkill /F /IM "Kuruk-Setup-2.1.17.exe" /T >> "%LOG%" 2>&1
taskkill /F /IM "Kivo-Setup-2.1.1.exe" /T >> "%LOG%" 2>&1
timeout /t 3 /nobreak >nul

echo. >> "%LOG%"
echo [2/5] rodando o desinstalador da versao instalada (silencioso) >> "%LOG%"
if exist "%D%\Uninstall Kuruk.exe" (
  "%D%\Uninstall Kuruk.exe" /S /currentuser /KEEP_APP_DATA >> "%LOG%" 2>&1
  echo desinstalador do Kuruk executado >> "%LOG%"
) else (
  echo nao havia desinstalador do Kuruk >> "%LOG%"
)
if exist "%DOLD%\Uninstall Kivo.exe" (
  "%DOLD%\Uninstall Kivo.exe" /S /currentuser /KEEP_APP_DATA >> "%LOG%" 2>&1
  echo desinstalador do Kivo executado >> "%LOG%"
) else (
  echo nao havia desinstalador do Kivo >> "%LOG%"
)
timeout /t 5 /nobreak >nul

echo. >> "%LOG%"
echo [3/5] apagando as pastas de instalacao >> "%LOG%"
call :apagar "%D%"
call :apagar "%DOLD%"

echo. >> "%LOG%"
echo [4/5] removendo chaves de registro do Kuruk e do Kivo >> "%LOG%"
reg delete "HKCU\Software\0e39fafb-067a-55cc-a164-1b99232f7973" /f >> "%LOG%" 2>&1
reg delete "HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\0e39fafb-067a-55cc-a164-1b99232f7973" /f >> "%LOG%" 2>&1
reg delete "HKLM\Software\0e39fafb-067a-55cc-a164-1b99232f7973" /f >> "%LOG%" 2>&1
reg delete "HKCU\Software\441dbd0e-faad-5973-853f-e0ee9d98c769" /f >> "%LOG%" 2>&1
reg delete "HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\441dbd0e-faad-5973-853f-e0ee9d98c769" /f >> "%LOG%" 2>&1
reg delete "HKLM\Software\441dbd0e-faad-5973-853f-e0ee9d98c769" /f >> "%LOG%" 2>&1

echo. >> "%LOG%"
echo --- CONFERENCIA FINAL --- >> "%LOG%"
if exist "%D%\Kuruk.exe" ( echo pasta do Kuruk: AINDA EXISTE >> "%LOG%" ) else ( echo pasta do Kuruk: LIMPA >> "%LOG%" )
if exist "%DOLD%\Kivo.exe" ( echo pasta do Kivo: AINDA EXISTE >> "%LOG%" ) else ( echo pasta do Kivo: LIMPA >> "%LOG%" )
reg query "HKCU\Software\0e39fafb-067a-55cc-a164-1b99232f7973" >nul 2>&1 && ( echo registro do Kuruk: AINDA EXISTE >> "%LOG%" ) || ( echo registro do Kuruk: LIMPO >> "%LOG%" )
reg query "HKCU\Software\441dbd0e-faad-5973-853f-e0ee9d98c769" >nul 2>&1 && ( echo registro do Kivo: AINDA EXISTE >> "%LOG%" ) || ( echo registro do Kivo: LIMPO >> "%LOG%" )
if exist "%APPDATA%\Kuruk\database\kuruk.db" ( echo seus dados do Kuruk: PRESERVADOS >> "%LOG%" ) else ( echo seus dados do Kuruk: NAO ENCONTRADOS >> "%LOG%" )
if exist "%APPDATA%\Kivo\database\kivo.db" ( echo seus dados antigos do Kivo: PRESERVADOS >> "%LOG%" ) else ( echo seus dados antigos do Kivo: NAO ENCONTRADOS >> "%LOG%" )
tasklist /FI "IMAGENAME eq Kuruk.exe" /FO CSV >> "%LOG%" 2>&1

echo. >> "%LOG%"
echo PRONTO. Agora rode:  %~dp0ENTREGA\Kuruk-Setup-2.1.17.exe >> "%LOG%"

start "" notepad "%LOG%"
exit /b 0

:apagar
if exist "%~1" (
  rmdir /s /q "%~1" >> "%LOG%" 2>&1
  if exist "%~1" ( echo %~1: AINDA EXISTE - algo segurando os arquivos >> "%LOG%" ) else ( echo %~1: pasta removida >> "%LOG%" )
) else (
  echo %~1: pasta nao existia >> "%LOG%"
)
exit /b 0
