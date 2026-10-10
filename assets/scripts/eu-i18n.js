// Мини-i18n EnergyUtils: RU ⇄ EN — двусторонний.
// Словарь RU→EN; для обратного направления инвертируем его. При apply(lang)
// проходим body и заменяем ЛЮБОЙ текст из словаря строго в нужную сторону,
// поэтому переключение работает в обе стороны многократно.
(function () {
  if (window.__euI18nLoaded) return;
  window.__euI18nLoaded = true;

  const RU2EN = {
    "Главная": "Home",
    "Версии": "Versions",
    "Моды": "Mods",
    "Аккаунты": "Accounts",
    "Настройки": "Settings",
    "Запустить игру": "Launch",
    "Запуск": "Launch",
    "Проверить обновления": "Check updates",
    "Проверка обновлений": "Check updates",
    "Скачать мод": "Download mod",
    "Обновить лаунчер": "Update launcher",
    "Быстрый запуск": "Quick launch",
    "Открыть папку": "Open folder",
    "Папка с модами": "Mods folder",
    "Официальный сайт": "Official site",
    "Поддержка": "Support",
    "Сбросить настройки игры": "Reset game options",
    "Вернёт options.txt к стандарту (GUI scale 2, VSync выкл., FPS без лимита). Полезно, если игра тормозит или картинка сломалась — все лаунчер-настройки сохранятся.":
      "Restores options.txt to defaults (GUI scale 2, VSync off, no FPS limit). Useful if the game lags or the picture is broken — launcher settings are kept.",
    "Папка со скриншотами": "Screenshots folder",
    "Открыть папку, куда Minecraft сохраняет скриншоты (F2 в игре).": "Open the folder where Minecraft saves screenshots (F2 in game).",
    "Проверить целостность": "Verify integrity",
    "Сверка ключевых файлов установки (клиент, мод, Java, библиотеки).": "Checks key install files (client, mod, Java, libraries).",
    "Диагностический пакет": "Diagnostic package",
    "Соберёт логи, версии и инфо о системе в один zip — удобно для поддержки.": "Packs logs, versions and system info into one zip — handy for support.",
    "Авто-память": "Auto-RAM",
    "Выделить оптимальный объём RAM под эту систему.": "Allocate optimal RAM for this system.",
    "Язык интерфейса": "Interface language",
    "Русский / English (применится после перезапуска страницы).": "Russian / English (applies after page reload).",
    "Выделение ОЗУ": "Memory",
    "Объём памяти для игры. Рекомендуется оставить запас системе.": "Memory for the game. Keep some headroom for the system.",
    "Консоль разработчика": "Dev console",
    "Логи запуска, последний кик (crash-report) и логи майна за 15 дней.": "Launch logs, last kick (crash report) and 15 days of MC logs.",
    "Сюда кидай свои моды — они автоматически подхватятся при следующем запуске.": "Drop your mods here — they'll be picked up on next launch.",
    "Строка с серверами на дашборде для запуска игры одним кликом.": "Server bar on the dashboard for one-click launch.",
    "Новости EnergyUtils": "EnergyUtils News",
    "Выход": "Exit",
    "Обновить": "Update",
    "Отмена": "Cancel",
    "Пропустить": "Skip",
    "Загрузить заново": "Reinstall",
    "Скачивание мода...": "Downloading mod...",
    "Мод установлен": "Mod installed",
    "Доступно обновление мода": "Mod update available",
    "Доступно обновление лаунчера": "Launcher update available",
    "Лаунчер актуален": "Launcher is up to date",
    "Мод актуален": "Mod is up to date",
    "Открыть": "Open",
    "Аккаунты": "Accounts",
    "Fabric 1.21.4": "Fabric 1.21.4",
    // Аккаунты
    "Аккаунты не добавлены ;(": "No accounts added ;(",
    "Локальный профиль": "Local profile",
    "По никнейму": "By nickname",
    "Менеджер аккаунтов": "Account manager",
    "Все": "All",
    "Локальный": "Local",
    "Новый аккаунт": "New account",
    "Аккаунт не выбран": "No account selected",
    "Добавить аккаунт": "Add account",
    "Удалить аккаунт": "Delete account",
    "Выбран": "Selected",
    "Выйти": "Log out",
    // Моды
    "Загрузка": "Loading",
    "Тянем список модов с сервера…": "Fetching mod list from server…",
    "Своя версия": "Custom version",
    "Скачать": "Download",
    "Удалить": "Delete",
    "Заменить": "Replace",
    // Версии
    "Установлено": "Installed",
    "Выбрать": "Select",
    "Версия недоступна": "Version unavailable",
    "Обновить игру": "Update game",
    "Играть": "Play",
    "Моды": "Mods",
    "Настройки": "Settings",
    "Версии": "Versions",
    "Главная": "Home",
    "Поддержка": "Support",
    "Официальный сайт": "Official site",
    "Закрыть EnergyUtils?": "Close EnergyUtils?",
    "Подтверждаю": "Confirm",
    "Остаться": "Stay",
  };

  const EN2RU = {};
  for (const [ru, en] of Object.entries(RU2EN)) EN2RU[en] = ru;

  async function currentLang() {
    try {
      const s = localStorage.getItem("eu_lang");
      if (s === "ru" || s === "en") return s;
    } catch (_) {}
    return "ru";
  }

  function walk(el, dict) {
    const children = Array.prototype.slice.call(el.childNodes);
    for (const node of children) {
      if (node.nodeType === 3) {
        const t = (node.nodeValue || "").trim();
        if (t && dict[t] && node.nodeValue !== dict[t]) node.nodeValue = node.nodeValue.replace(t, dict[t]);
      } else if (node.nodeType === 1 &&
                 !/script|style|textarea|input|select/i.test(node.tagName)) {
        walk(node, dict);
      }
    }
  }

  function apply(lang) {
    const dict = lang === "en" ? RU2EN : EN2RU;
    if (!dict) return;
    walk(document.body, dict);
  }

  window.euLang = currentLang;
  window.euApplyLang = apply;
  window.euSetLang = async (lang) => {
    const l = lang === "en" ? "en" : "ru";
    try { localStorage.setItem("eu_lang", l); } catch (_) {}
    apply(l);
  };

  let observer = null;
  function start() {
    currentLang().then((l) => {
      apply(l);
      if (observer) return;
      // Ключевое: наблюдатель перечитывает текущую локаль при КАЖДОЙ мутации,
      // чтобы после ручного euSetLang новые/изменённые узлы переводились в
      // актуальном направлении (а не в закреплённом при старте).
      observer = new MutationObserver(() => {
        currentLang().then((cur) => apply(cur));
      });
      try { observer.observe(document.body, { childList: true, subtree: true }); } catch (_) {}
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();