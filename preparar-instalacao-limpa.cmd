@echo off
REM ============================================================================
REM  Prepara a maquina para uma instalacao LIMPA do Kivo.
REM
REM  O que faz:
REM    1. encerra qualquer Kivo/instalador pendurado;
REM    2. roda o desinstalador da versao instalada, em silencio;
REM    3. apaga a pasta de instalacao;
REM    4. remove as chaves de registro do Kivo (a que faz o instalador achar
REM       que existe instalacao anterior);
REM    5. NAO toca em %APPDATA%\Kivo  -> seus dados, banco e backups ficam.
REM
REM  COMO USAR: de DUPLO CLIQUE. Depois rode o instalador.
REM ============================================================================

set D=%LOCALAPPDATA%\Programs\Kivo
set LOG=%~dp0preparar-limpeza.txt

echo Kivo - preparacao para instalacao limpa > "%LOG%"
echo Gerado em %DATE% %TIME% >> "%LOG%"
echo. >> "%LOG%"

echo [1/4] encerrando processos do Kivo >> "%LOG%"
taskkill /F /IM Kivo.exe /T >> "%LOG%" 2>&1
taskkill /F /IM "Kivo-Setup-2.1.1.exe" /T >> "%LOG%" 2>&1
taskkill /F /IM "Kivo Setup 2.1.1.exe" /T >> "%LOG%" 2>&1
timeout /t 3 /nobreak >nul

echo. >> "%LOG%"
echo [2/4] rodando o desinstalador da versao instalada (silencioso) >> "%LOG%"
if exist "%D%\Uninstall Kivo.exe" (
  "%D%\Uninstall Kivo.exe" /S /currentuser /KEEP_APP_DATA >> "%LOG%" 2>&1
  echo desinstalador executado >> "%LOG%"
) else (
  echo nao havia desinstalador >> "%LOG%"
)
timeout /t 5 /nobreak >nul

echo. >> "%LOG%"
echo [3/4] apagando a pasta de instalacao >> "%LOG%"
if exist "%D%" (
  rmdir /s /q "%D%" >> "%LOG%" 2>&1
  if exist "%D%" ( echo AINDA EXISTE - algo segurando os arquivos >> "%LOG%" ) else ( echo pasta removida >> "%LOG%" )
) else (
  echo pasta nao existia >> "%LOG%"
)

echo. >> "%LOG%"
echo [4/4] removendo chaves de registro do Kivo >> "%LOG%"
reg delete "HKCU\Software\441dbd0e-faad-5973-853f-e0ee9d98c769" /f >> "%LOG%" 2>&1
reg delete "HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\441dbd0e-faad-5973-853f-e0ee9d98c769" /f >> "%LOG%" 2>&1
reg delete "HKLM\Software\441dbd0e-faad-5973-853f-e0ee9d98c769" /f >> "%LOG%" 2>&1

echo. >> "%LOG%"
echo --- CONFERENCIA FINAL --- >> "%LOG%"
if exist "%D%\Kivo.exe" ( echo pasta de instalacao: AINDA EXISTE >> "%LOG%" ) else ( echo pasta de instalacao: LIMPA >> "%LOG%" )
reg query "HKCU\Software\441dbd0e-faad-5973-853f-e0ee9d98c769" >nul 2>&1 && ( echo registro: AINDA EXISTE >> "%LOG%" ) || ( echo registro: LIMPO >> "%LOG%" )
if exist "%APPDATA%\Kivo\database\kivo.db" ( echo seus dados: PRESERVADOS >> "%LOG%" ) else ( echo seus dados: NAO ENCONTRADOS >> "%LOG%" )
tasklist /FI "IMAGENAME eq Kivo.exe" /FO CSV >> "%LOG%" 2>&1

echo. >> "%LOG%"
echo PRONTO. Agora rode:  %~dp0ENTREGA\Kivo-Setup-2.1.1-CORRIGIDO.exe >> "%LOG%"

start "" notepad "%LOG%"
