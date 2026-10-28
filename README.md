# Team Sync per Obsidian

Plugin per Obsidian + server Node.js per tenere un vault su un server condiviso e lavorarci in più persone contemporaneamente.

- **Tutto il vault** (note e allegati) è salvato sul server; ogni dispositivo ne ha una copia locale e funziona anche offline.
- **Blocco per nota**: quando qualcuno inizia a scrivere in una nota la blocca; per gli altri diventa in sola lettura (🔒 con il nome di chi la sta modificando, anche nell'esplora file). Il blocco si rilascia chiudendo la nota, dopo qualche minuto senza modifiche, o con un comando.
- **Aggiornamenti in tempo reale** via WebSocket: le modifiche, i nuovi file, le rinomine e le eliminazioni arrivano subito a tutti.
- **Niente perdita di dati**: ogni versione resta salvata sul server; se due modifiche si scontrano (ad esempio modifiche fatte offline), la tua versione viene salvata accanto come `Nota (conflitto AAAA-MM-GG HHMM).md`.
- **Utenti con login**: ognuno ha utente e password; il server sa chi ha modificato cosa.

## Struttura

```
shared/   tipi del protocollo condivisi tra server e plugin
server/   backend: Fastify + WebSocket + SQLite (node:sqlite), file salvati per hash con storico versioni
plugin/   plugin Obsidian (desktop e mobile)
```

## Rilascio e messa in produzione

- [docs/RELEASE.md](docs/RELEASE.md): pubblicare una versione (`npm run bump`, tag, GitHub Actions) e installare il plugin nel team con BRAT.
- [docs/DEPLOY.md](docs/DEPLOY.md): server in produzione con Docker + HTTPS automatico (Caddy), utenti, backup, aggiornamenti.

## Avvio del server in locale

### Con Docker

```bash
docker compose up -d --build
```

Crea il primo utente amministratore:

```bash
docker compose exec team-sync node server/dist/cli.js user add mario --admin
```

### Senza Docker (Node.js 22.13 o superiore)

```bash
npm install
npm run build -w server
npm run user -w server -- add mario --admin
npm start -w server
```

Il server ascolta sulla porta `8787` e salva i dati in `./data` (o in `DATA_DIR`).

### Gestione utenti

```bash
npm run user -w server -- add <utente> [--admin]
npm run user -w server -- passwd <utente>
npm run user -w server -- remove <utente>
npm run user -w server -- list
```

Con Docker: `docker compose exec team-sync node server/dist/cli.js user ...`.

### Configurazione (variabili d'ambiente)

| Variabile | Default | Significato |
|---|---|---|
| `PORT` | `8787` | Porta HTTP |
| `HOST` | `0.0.0.0` | Interfaccia di ascolto |
| `DATA_DIR` | `./data` | Database e contenuti dei file |
| `LOCK_TTL_SECONDS` | `90` | Dopo quanto un blocco non rinnovato scade (dispositivo spento o offline) |
| `MAX_FILE_MB` | `100` | Dimensione massima di un file |
| `LOG_LEVEL` | `info` | Livello di log |

### HTTPS

In produzione mettete il server dietro un reverse proxy con HTTPS: password e token viaggiano nelle richieste. Esempio con Caddy (certificato automatico):

```
note.azienda.it {
    reverse_proxy localhost:8787
}
```

Il WebSocket (`/api/ws`) passa dal proxy senza configurazioni aggiuntive.

### Backup

`npm run user -w server -- ...` ha anche il comando di backup, sicuro con il server in funzione:

```bash
node server/dist/cli.js backup <cartella-di-destinazione>
```

Salva il database e tutti i contenuti (`blobs/`, copiati in modo incrementale). Ogni versione di ogni file resta salvata, anche dopo modifiche ed eliminazioni. In produzione usa `deploy/backup.sh` (vedi [docs/DEPLOY.md](docs/DEPLOY.md#5-backup)).

## Installazione del plugin

```bash
npm install
npm run build -w plugin
```

Copia `plugin/main.js`, `manifest.json` e `plugin/styles.css` in `<vault>/.obsidian/plugins/team-sync/`, poi in Obsidian: **Impostazioni → Plugin della community → Team Sync** (attivalo).

Serve Obsidian 1.8.7 o successivo. Nelle impostazioni del plugin inserisci l'indirizzo del server, utente e password, e premi **Accedi**. La password non viene salvata: il plugin conserva solo un token di sessione (in `.obsidian/plugins/team-sync/data.json`).

Se la cartella `.obsidian` viene copiata su un altro dispositivo o vault, il plugin se ne accorge: non riusa sessione e stato di sincronizzazione dell'originale e chiede di accedere di nuovo.

### Primo avvio con più persone

1. Una persona accede con il vault esistente: tutte le note vengono caricate sul server.
2. Gli altri partono da un **vault vuoto** e accedono: ricevono tutto.

Se qualcuno accede con un vault che contiene già note con lo stesso nome ma contenuto diverso, la sua versione non viene persa: diventa una copia "conflitto".

### Comandi (palette dei comandi)

- **Sincronizza ora** (anche cliccando la barra di stato)
- **Rilascia il blocco della nota corrente**
- **Mostra chi sta modificando**
- **Forza lo sblocco della nota corrente (admin)** — se qualcuno ha lasciato una nota bloccata

### Cosa non viene sincronizzato

- La cartella di configurazione `.obsidian/` (impostazioni, plugin, temi restano personali) e `.trash/`
- Le cartelle indicate in **Cartelle escluse** nelle impostazioni
- Le cartelle vuote

## Come funziona

- Ogni file sul server ha un numero di **versione**. Il plugin invia ogni modifica dicendo su quale versione si basa; se nel frattempo qualcun altro l'ha cambiata, il server rifiuta (409) e il plugin crea una copia di conflitto invece di sovrascrivere.
- I **blocchi** sono per dispositivo: la stessa persona su due dispositivi non può modificare la stessa nota in contemporanea. Il plugin li rinnova ogni 20 secondi; se un dispositivo sparisce, il blocco scade dopo `LOCK_TTL_SECONDS`.
- Le eliminazioni lasciano una "lapide" sul server così si propagano anche a chi era offline. Una modifica fatta offline vince su un'eliminazione fatta da altri (il file torna).
- Le eliminazioni ricevute dal server finiscono nel cestino locale secondo le preferenze di Obsidian.
- Protezione da eliminazioni di massa: se a una sincronizzazione completa mancano localmente molti file presenti sul server (almeno 10 e oltre il 20% di quelli tracciati), il plugin li riscarica invece di eliminarli per tutti, e lo segnala. Le eliminazioni fatte normalmente in Obsidian non sono soggette a questo limite.
- Il server rifiuta nomi di file che non tutti i sistemi possono creare (`<>:"|?*`, `CON`, `NUL`…, punti o spazi finali, cartelle nascoste) e nomi che differiscono solo per maiuscole/minuscole.

### API del server

| Metodo | Percorso | Descrizione |
|---|---|---|
| `POST` | `/api/auth/login` | `{username, password}` → `{token, user}` |
| `POST` | `/api/auth/logout` | Invalida il token, rilascia i blocchi del dispositivo |
| `GET` | `/api/files` | Tutti i file (con lapidi) e i blocchi attivi |
| `GET` | `/api/files/content?path=&version=` | Contenuto (versione corrente o passata) |
| `PUT` | `/api/files/content?path=&baseVersion=` | Crea/aggiorna (corpo `application/octet-stream`) |
| `DELETE` | `/api/files?path=&baseVersion=` | Elimina |
| `POST` | `/api/files/rename` | `{from, to, baseVersion}` |
| `GET` | `/api/files/history?path=` | Storico delle versioni |
| `POST` / `DELETE` | `/api/locks` | Prendi / rilascia un blocco |
| `POST` | `/api/locks/force-release` | Rimuovi il blocco di un altro (solo admin) |
| `GET` (WS) | `/api/ws` | Eventi in tempo reale; primo messaggio `{type:"auth", token}` |

Tutte le richieste (tranne login) vogliono `Authorization: Bearer <token>`. L'identificativo del dispositivo (`clientId`) lo assegna il server al login, legato alla sessione: non si può agire a nome di un altro dispositivo.

## Sviluppo

```bash
npm install
npm test            # test del server, della logica di sync e end-to-end con due dispositivi simulati
npm run typecheck
npm run dev -w plugin   # ricompila il plugin a ogni modifica
```

## Limiti attuali

- Niente editing simultaneo della stessa nota (per scelta: blocco per nota).
- Il blocco è preso dall'editor Markdown. Modifiche fatte fuori dall'editor (pannello Proprietà, caselle in modalità lettura, Canvas, plugin come Templater/Linter, l'aggiornamento automatico dei link quando si rinomina una nota) non prendono il blocco: se la nota è bloccata da un altro, diventano una copia "conflitto".
- Nessuna interfaccia per lo storico delle versioni nel plugin (i dati ci sono, via API).
- I blob delle versioni vecchie non vengono mai eliminati dal server.
- Nessun limite ai tentativi di login: esponete il server solo via HTTPS e, se pubblico, aggiungete un rate limit nel reverse proxy.
