# scrape-real-est 🏠

Scraper de propiedades inmobiliarias (ej. ZonaProp, MercadoLibre) con un sistema de scoring para evaluar oportunidades.

## 🚀 Requisitos

- [Node.js](https://nodejs.org/) v18+
- npm (incluido con Node)

## 📦 Instalación

Cloná el repositorio y movete a la carpeta:

```bash
git clone git@github.com:SBefaro/scrape-real-est.git
cd scrape-real-est
Instalá las dependencias:

bash
Copiar código
npm install
▶️ Uso
Ejecutá el scraper principal:

bash
Copiar código
node src/index.js
📊 Scorer
El archivo src/scorer.js contiene la lógica de normalización y cálculo de puntajes para las propiedades.

⚠️ Notas
No subas credenciales (credentials.json, .env) al repositorio.

El archivo .gitignore ya excluye node_modules/ y configuraciones sensibles.

Si necesitás variables privadas, usá un archivo .env (no incluido en el repo).# scrape-real-est
