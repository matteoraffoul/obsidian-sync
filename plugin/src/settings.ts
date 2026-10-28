import { Notice, PluginSettingTab, Setting, type App } from "obsidian";
import type TeamSyncPlugin from "./main";

export interface TeamSyncSettings {
  serverUrl: string;
  username: string;
  /** Minutes without edits after which our lock on a note is released. */
  idleReleaseMinutes: number;
  /** Vault folders that are never synced (one prefix per entry). */
  excludedFolders: string[];
}

export const DEFAULT_SETTINGS: TeamSyncSettings = {
  serverUrl: "",
  username: "",
  idleReleaseMinutes: 5,
  excludedFolders: [],
};

export class TeamSyncSettingTab extends PluginSettingTab {
  private password = "";

  constructor(
    app: App,
    private readonly plugin: TeamSyncPlugin,
  ) {
    super(app, plugin);
  }

  hide(): void {
    this.plugin.statusListener = undefined;
  }

  display(): void {
    const { containerEl } = this;
    const settings = this.plugin.settings;
    containerEl.empty();

    const loggedIn = this.plugin.isLoggedIn();
    const insecure = /^http:\/\/(?!localhost[:/]|localhost$|127\.0\.0\.1)/i.test(settings.serverUrl);

    new Setting(containerEl)
      .setName("Indirizzo del server")
      .setDesc(
        (loggedIn ? "Esci per cambiare server." : "Ad esempio https://note.azienda.it") +
          (insecure ? " ⚠️ Senza https password e note viaggiano in chiaro." : ""),
      )
      .addText((text) =>
        text
          .setPlaceholder("https://...")
          .setValue(settings.serverUrl)
          .setDisabled(loggedIn)
          .onChange(async (value) => {
            settings.serverUrl = value.trim().replace(/\/+$/, "");
            await this.plugin.saveSettings();
          }),
      );

    if (loggedIn) {
      const account = new Setting(containerEl)
        .setName(`Connesso come ${settings.username}`)
        .setDesc(`Stato: ${this.plugin.statusLabel()}`);
      this.plugin.statusListener = () => account.setDesc(`Stato: ${this.plugin.statusLabel()}`);
      account
        .addButton((button) => button.setButtonText("Sincronizza ora").onClick(() => this.plugin.syncNow(true)))
        .addButton((button) =>
          button
            .setButtonText("Esci")
            .setWarning()
            .onClick(async () => {
              await this.plugin.logout();
              this.display();
            }),
        );
    } else {
      new Setting(containerEl).setName("Utente").addText((text) =>
        text.setValue(settings.username).onChange((value) => {
          settings.username = value.trim();
        }),
      );
      new Setting(containerEl)
        .setName("Password")
        .addText((text) => {
          text.inputEl.type = "password";
          text.onChange((value) => {
            this.password = value;
          });
        })
        .addButton((button) =>
          button
            .setButtonText("Accedi")
            .setCta()
            .onClick(async () => {
              try {
                await this.plugin.login(settings.username, this.password);
                this.password = "";
                new Notice(`Team Sync: connesso come ${settings.username}`);
                this.display();
              } catch (err) {
                new Notice(`Accesso non riuscito: ${err instanceof Error ? err.message : String(err)}`);
              }
            }),
        );
    }

    new Setting(containerEl)
      .setName("Rilascia il blocco dopo (minuti)")
      .setDesc("Quando smetti di scrivere in una nota, dopo questo tempo gli altri possono modificarla.")
      .addText((text) =>
        text.setValue(String(settings.idleReleaseMinutes)).onChange(async (value) => {
          const minutes = Number(value);
          if (Number.isFinite(minutes) && minutes > 0) {
            settings.idleReleaseMinutes = minutes;
            await this.plugin.saveSettings();
          }
        }),
      );

    new Setting(containerEl)
      .setName("Cartelle escluse")
      .setDesc("Una per riga. Restano solo su questo dispositivo.")
      .addTextArea((text) =>
        text.setValue(settings.excludedFolders.join("\n")).onChange(async (value) => {
          settings.excludedFolders = value
            .split("\n")
            .map((line) => line.trim().replace(/^\/+|\/+$/g, ""))
            .filter(Boolean);
          await this.plugin.saveSettings();
          this.plugin.exclusionsChanged();
        }),
      );
  }
}
