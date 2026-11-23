/**
 * Setup and uninstall copy.
 *
 * The wizard is a separate window with a fixed 640x420 frame, so its strings are
 * not part of the 829-key application catalogue: an installer that renders in
 * English while the application renders in Turkish is the classic Vellium
 * mismatch this file exists to prevent. Six locales carry a complete copy here,
 * Arabic exercises (`dir="rtl"`), and every other registry language falls back
 * to English while still being selectable by its native name.
 *
 * No string contains a version badge: `APP_VERSION` appears once, inside the
 * welcome sentence, because the brand rule forbids a pill beside the logo.
 */

import { SUPPORTED_LANGUAGES, type LanguageMeta } from "../i18n/languages";

export interface SetupStrings {
  windowSetup: string;
  windowUninstall: string;
  install: string;
  update: string;
  uninstall: string;
  close: string;
  closeWindow: string;
  minimiseWindow: string;
  launch: string;
  cancel: string;
  copyDetails: string;
  options: string;
  hide: string;
  language: string;
  folder: string;
  browse: string;
  desktopShortcut: string;
  startMenu: string;
  startup: string;
  pathEntry: string;
  optionsHint: string;
  size: string;
  welcomeInstall: string;
  welcomeUpdate: string;
  installing: string;
  updating: string;
  removing: string;
  preparing: string;
  writing: string;
  finishing: string;
  doneTitle: string;
  doneBody: string;
  uninstallTitle: string;
  uninstallBody: string;
  dataLabel: string;
  dataHint: string;
  uninstalledTitle: string;
  keptBody: string;
  deletedBody: string;
  failedTitle: string;
  failedBody: string;
  footer: string;
}

type Variables = {
  app: string;
  version: string;
  oldVersion: string;
  size: string;
  dataDir: string;
  cli: string;
};

/** Fill `{name}` placeholders. A missing variable is left visible on purpose. */
export function interpolate(template: string, vars: Variables): string {
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = (vars as Record<string, string>)[name];
    return value === undefined ? match : value;
  });
}

const en: SetupStrings = {
  windowSetup: "{app} Setup",
  windowUninstall: "{app} Uninstall",
  install: "Install",
  update: "Update",
  uninstall: "Uninstall",
  close: "Close",
  closeWindow: "Close window",
  minimiseWindow: "Minimise window",
  launch: "Launch {app}",
  cancel: "Cancel",
  copyDetails: "Copy details",
  options: "Options",
  hide: "Hide",
  language: "Language",
  folder: "Install location",
  browse: "Change...",
  desktopShortcut: "Create a desktop shortcut",
  startMenu: "Create a Start menu shortcut",
  startup: "Start {app} when I sign in",
  pathEntry: 'Add the "{cli}" CLI command to PATH',
  optionsHint: "You can change these preferences later from Settings inside the application.",
  size: "{app} needs about {size} MB of disk space.",
  welcomeInstall: "Setup installs {app} {version} on this computer.",
  welcomeUpdate: "Setup updates {app} from {oldVersion} to {version}.",
  installing: "Installing {app}...",
  updating: "Updating {app}...",
  removing: "Removing {app}...",
  preparing: "Preparing",
  writing: "Writing files",
  finishing: "Finishing",
  doneTitle: "{app} is ready",
  doneBody: "Zenith is installed. The first launch measures this machine before it changes anything.",
  uninstallTitle: "Uninstall {app}",
  uninstallBody:
    "This removes {app} {version}, its desktop and Start menu shortcuts, and its PATH entry from this computer.",
  dataLabel: "Also delete my saved data and application settings",
  dataHint: "They are kept in {dataDir}. Keep them so they return if you reinstall.",
  uninstalledTitle: "{app} was uninstalled",
  keptBody: "Your saved data was kept in {dataDir} and will return if you reinstall.",
  deletedBody: "Your saved data was deleted from this computer.",
  failedTitle: "The operation did not finish",
  failedBody: "The detail below is the exact message that was reported. Nothing was left half-written.",
  footer: "Local-first - no telemetry, no account, no cloud.",
};

const tr: SetupStrings = {
  windowSetup: "{app} Kurulumu",
  windowUninstall: "{app} Kaldırma",
  install: "Kur",
  update: "Güncelle",
  uninstall: "Kaldır",
  close: "Kapat",
  closeWindow: "Pencereyi kapat",
  minimiseWindow: "Pencereyi küçült",
  launch: "{app} uygulamasını başlat",
  cancel: "İptal",
  copyDetails: "Detayları kopyala",
  options: "Seçenekler",
  hide: "Gizle",
  language: "Dil",
  folder: "Kurulum klasörü",
  browse: "Değiştir...",
  desktopShortcut: "Masaüstü kısayolu oluştur",
  startMenu: "Başlat menüsü kısayolu oluştur",
  startup: "Oturum açtığımda {app} uygulamasını başlat",
  pathEntry: '"{cli}" CLI komutunu PATH değişkenine ekle',
  optionsHint: "Bu tercihleri daha sonra uygulama içinden Ayarlar bölümünden değiştirebilirsiniz.",
  size: "{app} yaklaşık {size} MB disk alanına ihtiyaç duyar.",
  welcomeInstall: "Kurulum, bu bilgisayara {app} {version} sürümünü kurar.",
  welcomeUpdate: "Kurulum, {app} uygulamasını {oldVersion} sürümünden {version} sürümüne günceller.",
  installing: "{app} kuruluyor...",
  updating: "{app} güncelleniyor...",
  removing: "{app} kaldırılıyor...",
  preparing: "Hazırlanıyor",
  writing: "Dosyalar yazılıyor",
  finishing: "Tamamlanıyor",
  doneTitle: "{app} hazır",
  doneBody: "Zenith kuruldu. İlk açılış, hiçbir şeyi değiştirmeden önce bu makineyi ölçer.",
  uninstallTitle: "{app} uygulamasını kaldır",
  uninstallBody:
    "Bu işlem {app} {version} sürümünü, masaüstü ve Başlat menüsü kısayollarını ve PATH kaydını bu bilgisayardan kaldırır.",
  dataLabel: "Kayıtlı verilerimi ve uygulama ayarlarımı da sil",
  dataHint: "{dataDir} içinde bulunurlar. Yeniden kurduğunuzda geri gelmeleri için saklayın.",
  uninstalledTitle: "{app} kaldırıldı",
  keptBody: "Kayıtlı verileriniz {dataDir} içinde saklandı; yeniden kurarsanız geri gelirler.",
  deletedBody: "Kayıtlı verileriniz bu bilgisayardan silindi.",
  failedTitle: "İşlem tamamlanmadı",
  failedBody: "Aşağıdaki ayrıntı, bildirilen tam mesajdır. Hiçbir şey yarım bırakılmadı.",
  footer: "Yerel öncelikli - telemetri yok, hesap yok, bulut yok.",
};

const de: SetupStrings = {
  windowSetup: "{app} Setup",
  windowUninstall: "{app} deinstallieren",
  install: "Installieren",
  update: "Aktualisieren",
  uninstall: "Deinstallieren",
  close: "Schließen",
  closeWindow: "Fenster schließen",
  minimiseWindow: "Fenster minimieren",
  launch: "{app} starten",
  cancel: "Abbrechen",
  copyDetails: "Details kopieren",
  options: "Optionen",
  hide: "Ausblenden",
  language: "Sprache",
  folder: "Installationsordner",
  browse: "Ändern...",
  desktopShortcut: "Desktop-Verknüpfung erstellen",
  startMenu: "Startmenü-Verknüpfung erstellen",
  startup: "{app} bei der Anmeldung starten",
  pathEntry: 'Den CLI-Befehl "{cli}" zum PATH hinzufügen',
  optionsHint: "Sie können diese Einstellungen später in den Einstellungen der Anwendung ändern.",
  size: "{app} benötigt etwa {size} MB Speicherplatz.",
  welcomeInstall: "Das Setup installiert {app} {version} auf diesem Computer.",
  welcomeUpdate: "Das Setup aktualisiert {app} von {oldVersion} auf {version}.",
  installing: "{app} wird installiert...",
  updating: "{app} wird aktualisiert...",
  removing: "{app} wird entfernt...",
  preparing: "Vorbereiten",
  writing: "Dateien werden geschrieben",
  finishing: "Abschließen",
  doneTitle: "{app} ist bereit",
  doneBody: "Zenith ist installiert. Der erste Start misst diesen Computer, bevor etwas geändert wird.",
  uninstallTitle: "{app} deinstallieren",
  uninstallBody:
    "Dies entfernt {app} {version}, die Desktop- und Startmenü-Verknüpfungen sowie den PATH-Eintrag von diesem Computer.",
  dataLabel: "Auch meine gespeicherten Daten und Einstellungen löschen",
  dataHint: "Sie liegen in {dataDir}. Behalten Sie sie, damit sie bei einer Neuinstallation zurückkehren.",
  uninstalledTitle: "{app} wurde deinstalliert",
  keptBody: "Ihre gespeicherten Daten bleiben in {dataDir} und kehren bei einer Neuinstallation zurück.",
  deletedBody: "Ihre gespeicherten Daten wurden von diesem Computer gelöscht.",
  failedTitle: "Der Vorgang wurde nicht abgeschlossen",
  failedBody: "Die folgende Angabe ist die gemeldete Meldung. Es blieb nichts halb geschrieben.",
  footer: "Lokal zuerst - keine Telemetrie, kein Konto, keine Cloud.",
};

const fr: SetupStrings = {
  windowSetup: "Installation de {app}",
  windowUninstall: "Désinstallation de {app}",
  install: "Installer",
  update: "Mettre à jour",
  uninstall: "Désinstaller",
  close: "Fermer",
  closeWindow: "Fermer la fenêtre",
  minimiseWindow: "Réduire la fenêtre",
  launch: "Lancer {app}",
  cancel: "Annuler",
  copyDetails: "Copier les détails",
  options: "Options",
  hide: "Masquer",
  language: "Langue",
  folder: "Dossier d'installation",
  browse: "Modifier...",
  desktopShortcut: "Créer un raccourci sur le Bureau",
  startMenu: "Créer un raccourci dans le menu Démarrer",
  startup: "Lancer {app} à l'ouverture de session",
  pathEntry: 'Ajouter la commande CLI "{cli}" au PATH',
  optionsHint: "Vous pourrez modifier ces préférences plus tard depuis les paramètres de l'application.",
  size: "{app} nécessite environ {size} Mo d'espace disque.",
  welcomeInstall: "L'installation installe {app} {version} sur cet ordinateur.",
  welcomeUpdate: "L'installation met à jour {app} de {oldVersion} vers {version}.",
  installing: "Installation de {app}...",
  updating: "Mise à jour de {app}...",
  removing: "Suppression de {app}...",
  preparing: "Préparation",
  writing: "Écriture des fichiers",
  finishing: "Finalisation",
  doneTitle: "{app} est prêt",
  doneBody: "Zenith est installé. Le premier lancement mesure cet ordinateur avant de modifier quoi que ce soit.",
  uninstallTitle: "Désinstaller {app}",
  uninstallBody:
    "Cela supprime {app} {version}, ses raccourcis du Bureau et du menu Démarrer, et son entrée PATH de cet ordinateur.",
  dataLabel: "Supprimer aussi mes données enregistrées et mes paramètres",
  dataHint: "Ils se trouvent dans {dataDir}. Conservez-les pour qu'ils reviennent en cas de réinstallation.",
  uninstalledTitle: "{app} a été désinstallé",
  keptBody: "Vos données sont conservées dans {dataDir} et reviendront en cas de réinstallation.",
  deletedBody: "Vos données enregistrées ont été supprimées de cet ordinateur.",
  failedTitle: "L'opération ne s'est pas terminée",
  failedBody: "Le détail ci-dessous est le message exact signalé. Rien n'a été laissé à moitié écrit.",
  footer: "Local d'abord - aucune télémétrie, aucun compte, aucun cloud.",
};

const es: SetupStrings = {
  windowSetup: "Instalación de {app}",
  windowUninstall: "Desinstalación de {app}",
  install: "Instalar",
  update: "Actualizar",
  uninstall: "Desinstalar",
  close: "Cerrar",
  closeWindow: "Cerrar ventana",
  minimiseWindow: "Minimizar ventana",
  launch: "Iniciar {app}",
  cancel: "Cancelar",
  copyDetails: "Copiar detalles",
  options: "Opciones",
  hide: "Ocultar",
  language: "Idioma",
  folder: "Carpeta de instalación",
  browse: "Cambiar...",
  desktopShortcut: "Crear un acceso directo en el escritorio",
  startMenu: "Crear un acceso directo en el menú Inicio",
  startup: "Iniciar {app} al iniciar sesión",
  pathEntry: 'Añadir el comando CLI "{cli}" al PATH',
  optionsHint: "Puede cambiar estas preferencias más tarde desde Ajustes dentro de la aplicación.",
  size: "{app} necesita unos {size} MB de espacio en disco.",
  welcomeInstall: "La instalación instala {app} {version} en este equipo.",
  welcomeUpdate: "La instalación actualiza {app} de {oldVersion} a {version}.",
  installing: "Instalando {app}...",
  updating: "Actualizando {app}...",
  removing: "Quitando {app}...",
  preparing: "Preparando",
  writing: "Escribiendo archivos",
  finishing: "Finalizando",
  doneTitle: "{app} está listo",
  doneBody: "Zenith está instalado. El primer inicio mide este equipo antes de cambiar nada.",
  uninstallTitle: "Desinstalar {app}",
  uninstallBody:
    "Esto quita {app} {version}, sus accesos directos del escritorio y del menú Inicio, y su entrada PATH de este equipo.",
  dataLabel: "Eliminar también mis datos guardados y la configuración",
  dataHint: "Se guardan en {dataDir}. Consérvelos para que vuelvan si reinstala.",
  uninstalledTitle: "{app} se ha desinstalado",
  keptBody: "Sus datos guardados se conservaron en {dataDir} y volverán si reinstala.",
  deletedBody: "Sus datos guardados se eliminaron de este equipo.",
  failedTitle: "La operación no terminó",
  failedBody: "El detalle siguiente es el mensaje exacto notificado. Nada quedó a medio escribir.",
  footer: "Local primero - sin telemetría, sin cuenta, sin nube.",
};

const ar: SetupStrings = {
  windowSetup: "إعداد {app}",
  windowUninstall: "إزالة {app}",
  install: "تثبيت",
  update: "تحديث",
  uninstall: "إزالة",
  close: "إغلاق",
  closeWindow: "إغلاق النافذة",
  minimiseWindow: "تصغير النافذة",
  launch: "تشغيل {app}",
  cancel: "إلغاء",
  copyDetails: "نسخ التفاصيل",
  options: "خيارات",
  hide: "إخفاء",
  language: "اللغة",
  folder: "مجلد التثبيت",
  browse: "تغيير...",
  desktopShortcut: "إنشاء اختصار على سطح المكتب",
  startMenu: "إنشاء اختصار في قائمة ابدأ",
  startup: "تشغيل {app} عند تسجيل الدخول",
  pathEntry: 'إضافة أمر CLI "{cli}" إلى PATH',
  optionsHint: "يمكنك تغيير هذه التفضيلات لاحقًا من الإعدادات داخل التطبيق.",
  size: "يحتاج {app} إلى نحو {size} ميغابايت من مساحة القرص.",
  welcomeInstall: "يثبّت الإعداد {app} {version} على هذا الكمبيوتر.",
  welcomeUpdate: "يحدّث الإعداد {app} من {oldVersion} إلى {version}.",
  installing: "جارٍ تثبيت {app}...",
  updating: "جارٍ تحديث {app}...",
  removing: "جارٍ إزالة {app}...",
  preparing: "التحضير",
  writing: "كتابة الملفات",
  finishing: "الإنهاء",
  doneTitle: "{app} جاهز",
  doneBody: "تم تثبيت Zenith. يقيس التشغيل الأول هذا الكمبيوتر قبل تغيير أي شيء.",
  uninstallTitle: "إزالة {app}",
  uninstallBody:
    "يؤدي هذا إلى إزالة {app} {version} واختصارات سطح المكتب وقائمة ابدأ وإدخال PATH من هذا الكمبيوتر.",
  dataLabel: "حذف بياناتي المحفوظة وإعدادات التطبيق أيضًا",
  dataHint: "تُحفظ في {dataDir}. أبقها لتعود إذا أعدت التثبيت.",
  uninstalledTitle: "تمت إزالة {app}",
  keptBody: "تم الاحتفاظ ببياناتك المحفوظة في {dataDir} وستعود إذا أعدت التثبيت.",
  deletedBody: "تم حذف بياناتك المحفوظة من هذا الكمبيوتر.",
  failedTitle: "لم تكتمل العملية",
  failedBody: "التفصيل أدناه هو الرسالة الدقيقة التي تم الإبلاغ عنها. لم يبق شيء نصف مكتوب.",
  footer: "محلي أولًا - بلا قياسات، بلا حساب، بلا سحابة.",
};

const CATALOGUES: Record<string, SetupStrings> = { en, tr, de, fr, es, ar };

/** The installer locale list: all 73 registry languages, native name first. */
export const SETUP_LANGUAGES: readonly LanguageMeta[] = SUPPORTED_LANGUAGES;

export function setupStringsFor(code: string): SetupStrings {
  return CATALOGUES[code] ?? en;
}

export function setupDirection(code: string): "ltr" | "rtl" {
  return SETUP_LANGUAGES.find((entry) => entry.code === code)?.dir ?? "ltr";
}
