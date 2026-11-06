@echo off
setlocal
REM Le point final n'est pas decoratif : %~dp0 se termine par un backslash, et
REM "C:\...\agent\" fait echapper le guillemet fermant. Le "." le neutralise.
cd /d "%~dp0."
title Claude Office - agent du poste

REM ---------------------------------------------------------------------------
REM  Lance l'agent Claude Office sur ce poste.
REM
REM  Au premier lancement, la configuration (serveur + jeton) est enregistree
REM  dans %APPDATA%\claude-office\agent.json. Ensuite ce fichier suffit seul :
REM  double-clic, et c'est tout.
REM
REM  Pour cette premiere fois, posez a cote de ce .bat un fichier "agent.cfg"
REM  contenant deux lignes :
REM
REM      SERVEUR=http://adresse-du-serveur:4317
REM      JETON=le-jeton-donne-par-l-administrateur
REM
REM  agent.cfg n'est pas versionne : un jeton n'a rien a faire dans un depot.
REM ---------------------------------------------------------------------------

REM Chemin absolu : le .bat doit marcher aussi lance depuis un raccourci, un autre
REM dossier, ou le planificateur de taches.
set "EXE=%~dp0claude-office-agent.exe"
set "CFG=%~dp0agent.cfg"
set "CONFIG=%APPDATA%\claude-office\agent.json"

if not exist "%EXE%" goto pas_d_exe

REM L'agent cherche index.html dans son dossier courant : depuis le depot, la page
REM est un cran au-dessus. S'y placer suffit a activer la vue locale, celle qui
REM garde tout le detail sur ce poste. Les chemins ci-dessus sont absolus, donc
REM changer de dossier ne casse rien.
if exist "%~dp0..\index.html" cd /d "%~dp0.."

REM On LIT agent.cfg, on ne l'execute pas : `call` n'accepte que .bat et .cmd, et
REM un fichier de configuration n'a pas a etre un script. `eol=#` laisse la place
REM aux commentaires.
if exist "%CFG%" (
  for /f "usebackq eol=# tokens=1* delims==" %%A in ("%CFG%") do set "%%A=%%B"
)
if exist "%CONFIG%" goto lancer
if "%SERVEUR%"=="" goto pas_de_config
if "%JETON%"=="" goto pas_de_config

echo.
echo   Premiere configuration : %SERVEUR%
echo   Elle sera enregistree ; les prochaines fois, ce .bat suffira seul.
echo.
REM -hooks : l'agent installe lui-meme les hooks de Claude Code dans
REM %USERPROFILE%\.claude\settings.json. Sans eux, l'agent se connecte
REM parfaitement et ne recoit rien : le poste apparait dans le bureau, en ligne,
REM avec zero session, la panne la plus deroutante, parce que tout a l'air de
REM marcher. L'operation est sans effet quand ils sont deja en place, donc on la
REM refait a chaque lancement : un poste ou Claude Code est installe plus tard se
REM repare tout seul.
"%EXE%" -server "%SERVEUR%" -token "%JETON%" -save -hooks
set CODE=%errorlevel%
goto fin

:lancer
echo.
echo   Agent en marche. Laissez cette fenetre ouverte.
echo   Ctrl+C ou fermer la fenetre arrete la publication.
echo.
"%EXE%" -hooks
set CODE=%errorlevel%

:fin
REM Sortie 0 = arret demande. Tout le reste merite une explication a l'ecran,
REM sinon la fenetre se referme et personne ne saura jamais pourquoi.
if not "%CODE%"=="0" (
  echo.
  echo   L'agent s'est arrete, code %CODE%.
  echo   Le message juste au-dessus dit pourquoi.
  echo   Si l'agent tournait : http://127.0.0.1:4317/status
  echo.
  pause
)
exit /b %CODE%

:pas_d_exe
echo.
echo   %EXE% est introuvable dans ce dossier.
echo.
echo   Avec Go installe :  go build -o %EXE% .
echo   Sinon, demandez l'executable a l'administrateur du bureau.
echo.
pause
exit /b 1

:pas_de_config
echo.
echo   Aucune configuration enregistree, et pas de fichier agent.cfg.
echo.
echo   Creez "agent.cfg" a cote de ce fichier, avec ces deux lignes :
echo.
echo       SERVEUR=http://adresse-du-serveur:4317
echo       JETON=le-jeton-donne-par-l-administrateur
echo.
pause
exit /b 1
