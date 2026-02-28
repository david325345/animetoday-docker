# Anime Today Addon - Coolify Deployment

## Deployment na Coolify (Hetzner)

### 1. Příprava na Coolify

1. **Vytvořte nový projekt** v Coolify
2. **Připojte GitHub repozitář**: `https://github.com/david325345/animetoday`
3. **Nastavte branch**: `main`

### 2. Environment Variables

V Coolify nastavte tyto proměnné:

```
PORT=7000
REALDEBRID_API_KEY=váš_rd_klíč
TMDB_API_KEY=váš_tmdb_klíč
APP_URL=https://vase-domena.com
```

### 3. Build Settings

- **Build Pack**: Dockerfile
- **Dockerfile Path**: `./Dockerfile`
- **Port**: 7000

### 4. Domain

Nastavte vlastní doménu nebo použijte Coolify subdoménu:
- `anime.vase-domena.com`
- Nebo Coolify default

### 5. Deploy

Klikněte **Deploy** a počkejte ~2 minuty.

## Lokální testování

```bash
# Vytvořit .env soubor
cat > .env << EOF
REALDEBRID_API_KEY=váš_klíč
TMDB_API_KEY=váš_klíč
APP_URL=http://localhost:7000
EOF

# Spustit s Docker Compose
docker-compose up -d

# Nebo přímo Docker
docker build -t anime-addon .
docker run -p 7000:7000 --env-file .env anime-addon
```

## Testování

```bash
# Test manifestu
curl http://localhost:7000/manifest.json

# Test katalogu
curl http://localhost:7000/catalog/series/anime-today.json
```

## Monitorování

Coolify automaticky:
- ✅ Restartuje při pádu
- ✅ Healthcheck každých 30s
- ✅ Loguje všechny výstupy
- ✅ SSL certifikát (Let's Encrypt)

## Cache update

Cron job běží **každý den ve 4:00** (automaticky).
