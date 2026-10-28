# Rilascio

Ogni versione pubblica insieme il plugin e il server con lo stesso numero di versione:

- una **release GitHub** con `main.js`, `manifest.json` e `styles.css`: è quello che installa BRAT nei vault del team;
- l'**immagine del server** su GitHub Container Registry: `ghcr.io/<owner>/<repository>-server:<versione>` (e `:latest`).

Tutto parte dal workflow `.github/workflows/release.yml` quando si fa il push di un tag di versione. Il workflow si ferma senza pubblicare nulla se i test falliscono o se il tag non corrisponde a `manifest.json`.

## Una tantum: il repository

1. Crea un repository su GitHub (privato va bene) e fai il push del progetto.
2. In **Settings → Actions → General → Workflow permissions** scegli *Read and write permissions* (serve per creare release e pubblicare l'immagine).
3. Il workflow `CI` gira a ogni push su `main` e a ogni pull request: test, typecheck e build.

## Pubblicare una versione

```bash
git checkout main && git pull
npm run bump -- patch          # oppure minor, major, o una versione precisa: npm run bump -- 1.0.0
npm install                    # aggiorna package-lock.json
git commit -am "Release 0.1.1"
git tag 0.1.1
git push && git push origin 0.1.1
```

Regole:

- Il tag è la versione **senza** `v` davanti (`0.1.1`, non `v0.1.1`): è il formato che Obsidian e BRAT si aspettano.
- `npm run bump` aggiorna `manifest.json`, `versions.json` e tutti i `package.json`. Se la nuova versione richiede un Obsidian più recente: `npm run bump -- minor --min-app 1.9.0`.
- `patch` per correzioni, `minor` per nuove funzioni, `major` per cambiamenti incompatibili tra plugin e server (in quel caso aggiorna prima il server, poi i plugin).

Segui l'avanzamento in **Actions → Release**. Al termine trovi la release in **Releases** e l'immagine in **Packages**.

Poi aggiorna il server: vedi [DEPLOY.md → Aggiornare](DEPLOY.md#aggiornare).

## Installare il plugin nel team (BRAT)

Ogni persona, una volta sola:

1. In Obsidian: **Impostazioni → Plugin della community → Sfoglia**, cerca **BRAT** (Obsidian42 - BRAT), installalo e attivalo.
2. Solo se il repository è privato: crea un token GitHub (*fine-grained*, accesso in sola lettura a *Contents* di questo repository) e incollalo nelle impostazioni di BRAT (*Personal access token*).
3. Palette dei comandi → **BRAT: Add a beta plugin for testing** → incolla l'indirizzo del repository (es. `https://github.com/azienda/obsidian-team-sync`) → **Add plugin**.
4. **Impostazioni → Plugin della community** → attiva **Team Sync**.
5. Impostazioni di Team Sync: indirizzo del server (`https://note.azienda.it`), utente e password → **Accedi**.

BRAT controlla gli aggiornamenti all'avvio di Obsidian (si può disattivare o forzare con il comando *BRAT: Check for updates to all beta plugins*).

Per il primo avvio con un vault già esistente, vedi il README: una persona carica il vault, gli altri partono da un vault vuoto.

## Senza BRAT

Scarica `main.js`, `manifest.json` e `styles.css` dalla release e copiali in `<vault>/.obsidian/plugins/team-sync/`, poi attiva il plugin. Gli aggiornamenti vanno ripetuti a mano.

## Compatibilità tra versioni

Plugin e server della stessa versione sono sempre compatibili. Tra versioni `patch` e `minor` diverse il protocollo resta compatibile; una versione `major` può richiedere di aggiornare tutto insieme. In caso di dubbio aggiorna prima il server: `GET /api/health` mostra la versione in esecuzione.
