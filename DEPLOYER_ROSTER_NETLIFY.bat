@echo off
setlocal
cd /d "%~dp0"
echo.
echo ===== DEPLOIEMENT DU ROSTER EMS EXISTANT =====
echo ATTENTION : choisir le site NETLIFY DU ROSTER, pas Gain de Temps.
echo.
where node >nul 2>nul
if errorlevel 1 (
 echo Node.js est necessaire. Installez-le depuis https://nodejs.org/
 pause
 exit /b 1
)
call npx --yes netlify-cli login
if errorlevel 1 goto fail
call npx --yes netlify-cli link
if errorlevel 1 goto fail
call npx --yes netlify-cli deploy --prod --dir . --functions netlify/functions
if errorlevel 1 goto fail
echo.
echo Deployment envoye. Verifiez la connexion Discord et le journal Gain de Temps dans Netlify.
pause
exit /b 0
:fail
echo.
echo Echec du deploiement. Aucun succes confirme. Consultez le message ci-dessus.
pause
exit /b 1
