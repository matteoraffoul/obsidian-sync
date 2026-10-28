# Deploy del server

Guida per mettere online il server Team Sync su una macchina Linux con Docker, con HTTPS automatico tramite Caddy. Si fa una volta; gli aggiornamenti sono due comandi (vedi [Aggiornare](#aggiornare)).

## Cosa serve

- Una macchina Linux raggiungibile dal team (VPS, VM o server aziendale) con almeno 1 GB di RAM e spazio disco pari ad almeno il doppio della dimensione del vault (il server conserva ogni versione dei file).
- Un nome DNS (es. `note.azienda.it`) con un record A/AAAA che punta all'IP della macchina.
- Porte 80 e 443 aperte verso la macchina (80 serve a Caddy per ottenere il certificato).
- Docker con il plugin Compose: https://docs.docker.com/engine/install/

Se il server deve essere raggiungibile solo in ufficio o via VPN, vedi [Senza internet pubblico](#senza-internet-pubblico).

## 1. Prima release

L'immagine del server viene pubblicata dal workflow **Release** su GitHub Container Registry quando si crea un tag di versione (vedi [RELEASE.md](RELEASE.md)). Dopo la prima release l'immagine è:

```
ghcr.io/<owner>/<repository>-server:<versione>
```

(tutto in minuscolo; la trovi anche nella pagina del repository, sezione **Packages**).

Se il repository è **privato**, anche l'immagine lo è: sul server fai il login a GHCR con un token GitHub (classic, permesso `read:packages`):

```bash
echo <TOKEN> | docker login ghcr.io -u <utente-github> --password-stdin
```

## 2. Preparare la macchina

Copia sulla macchina la cartella `deploy/` del repository, ad esempio in `/opt/team-sync`:

```bash
sudo mkdir -p /opt/team-sync && cd /opt/team-sync
# copia qui: docker-compose.yml, Caddyfile, .env.example, backup.sh
cp .env.example .env
nano .env          # DOMAIN, TEAM_SYNC_IMAGE, TEAM_SYNC_VERSION
mkdir -p backups && sudo chown 1000:1000 backups   # il server gira come utente 1000
chmod +x backup.sh
```

## 3. Avviare

```bash
docker compose up -d
docker compose logs -f        # Ctrl+C per uscire
```

Dopo qualche secondo Caddy ottiene il certificato. Verifica:

```bash
curl https://note.azienda.it/api/health
# {"ok":true,"version":"0.1.0"}
```

## 4. Creare gli utenti

```bash
docker compose exec team-sync node server/dist/cli.js user add mario --admin
docker compose exec team-sync node server/dist/cli.js user add giulia
docker compose exec team-sync node server/dist/cli.js user list
```

La password viene chiesta senza mostrarla. Altri comandi: `user passwd <utente>` (cambia password e disconnette tutte le sue sessioni), `user remove <utente>`.

Gli admin possono forzare lo sblocco di una nota dal plugin (comando *Forza lo sblocco della nota corrente*).

## 5. Backup

`backup.sh` salva database e contenuti mentre il server è in funzione:

- `backups/current/`: ultima copia completa (database + tutti i contenuti, copiati in modo incrementale);
- `backups/team-sync-AAAA-MM-GG.db`: una copia del database per giorno, tenute 30 giorni (`KEEP_DAYS`).

Pianificalo ogni notte:

```bash
sudo crontab -e
# aggiungi:
15 2 * * * /opt/team-sync/backup.sh >> /var/log/team-sync-backup.log 2>&1
```

Copia poi la cartella `backups/` anche fuori dalla macchina (rsync, restic, backup del provider…): un backup sullo stesso disco non protegge da un guasto del disco.

### Ripristino

```bash
cd /opt/team-sync
docker compose stop team-sync
docker compose run --rm --no-deps -v ./backups/current:/restore team-sync \
  sh -c 'rm -f /data/team-sync.db-wal /data/team-sync.db-shm && cp -r /restore/. /data/'
# per tornare a un giorno preciso, dopo il comando sopra:
#   cp backups/team-sync-2026-10-20.db backups/current/team-sync.db  (e ripeti il comando)
docker compose start team-sync
```

Dopo un ripristino i plugin si rimettono in pari da soli. Le modifiche fatte dopo il backup che sono ancora sui dispositivi vengono ricaricate; quelle in conflitto diventano copie "conflitto".

### Recuperare una singola versione

Ogni versione di ogni file resta sul server. Lo storico di una nota è disponibile via API:

```bash
TOKEN=$(curl -s -X POST https://note.azienda.it/api/auth/login -H 'content-type: application/json' \
  -d '{"username":"mario","password":"..."}' | sed 's/.*"token":"\([^"]*\)".*/\1/')
curl -s -H "authorization: Bearer $TOKEN" "https://note.azienda.it/api/files/history?path=Progetti/Piano.md"
curl -s -H "authorization: Bearer $TOKEN" "https://note.azienda.it/api/files/content?path=Progetti/Piano.md&version=3" -o Piano-v3.md
```

## Aggiornare

Dopo una nuova release (vedi [RELEASE.md](RELEASE.md)):

```bash
cd /opt/team-sync
nano .env                  # TEAM_SYNC_VERSION=0.2.0 (o lascia "latest")
docker compose pull
docker compose up -d
curl https://note.azienda.it/api/health   # controlla la versione
```

Fai un backup prima di ogni aggiornamento. I plugin si riconnettono da soli in pochi secondi; i blocchi sulle note vengono ripresi automaticamente da chi sta scrivendo.

Per tornare indietro: rimetti la versione precedente in `.env` e ripeti `pull` + `up -d`.

## Senza internet pubblico

Se il server è raggiungibile solo dalla rete aziendale o via VPN, Caddy non può ottenere un certificato pubblico. Due possibilità:

- **Certificato aziendale**: sostituisci il contenuto di `Caddyfile` con
  ```
  {$DOMAIN} {
  	tls /certs/cert.pem /certs/key.pem
  	reverse_proxy team-sync:8787
  }
  ```
  e monta la cartella dei certificati nel servizio `caddy` (`- ./certs:/certs:ro`).
- **Certificato interno di Caddy**: usa `tls internal` al posto della riga `tls ...`. Funziona, ma ogni dispositivo deve fidarsi della CA di Caddy (da installare a mano, scomodo su mobile).

Evita HTTP semplice: password, token e note viaggerebbero in chiaro (il plugin lo segnala nelle impostazioni).

## Configurazione

Variabili in `.env`:

| Variabile | Default | Significato |
|---|---|---|
| `DOMAIN` | — | Nome pubblico del server |
| `TEAM_SYNC_IMAGE` | — | Immagine del server su GHCR |
| `TEAM_SYNC_VERSION` | `latest` | Versione dell'immagine |
| `LOCK_TTL_SECONDS` | `90` | Dopo quanto scade il blocco di un dispositivo sparito |
| `MAX_FILE_MB` | `100` | Dimensione massima di un file |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |

## Problemi frequenti

| Sintomo | Causa probabile |
|---|---|
| Il plugin resta "offline" | DNS non ancora propagato, porte 80/443 chiuse, URL nelle impostazioni senza `https://` |
| `docker compose up` chiede `TEAM_SYNC_IMAGE` | Manca il file `.env` |
| `pull access denied` | Repository privato: fai `docker login ghcr.io` (punto 1) |
| Caddy non ottiene il certificato | La porta 80 non arriva alla macchina, o il DNS punta altrove: `docker compose logs caddy` |
| `backup.sh`: permission denied su `/backups` | `sudo chown 1000:1000 backups` |
| Una nota resta bloccata | Chi la teneva ha chiuso male Obsidian: il blocco scade dopo `LOCK_TTL_SECONDS`, oppure un admin usa *Forza lo sblocco* |
