#!/bin/sh
# EnergyUtils Launcher — запуск одним файлом на любом Linux (Debian, Arch, ...).
# Цель: положить этот скрипт ИЛИ AppImage на рабочий стол и запустить двойным кликом.
set -e

# Репозиторий и тег/релиз для самозагрузки AppImage, если файла рядом нет.
REPO="hibera1/energyutils-linux"
APPIMAGE_NAME="EnergyUtils-2.1.0-linux-x64.AppImage"

HERE="$(cd "$(dirname "$0")" && pwd)"
TARGET="$HERE/$APPIMAGE_NAME"

# 1) Если рядом лежит AppImage — запускаем его.
if [ -f "$TARGET" ]; then
  chmod +x "$TARGET"
  # Извлекаем-и-запускаем при отсутствии FUSE; иначе запускаем напрямую.
  if (command -v fusermount >/dev/null 2>&1); then
    exec "$TARGET"
  else
    exec "$TARGET" --appimage-extract-and-run
  fi
fi

# 2) Иначе скачиваем последний AppImage из GitHub Release и запускаем.
echo "AppImage не найден рядом. Скачиваю последнюю версию с GitHub..."
mkdir -p "$HERE"
URL="https://github.com/$REPO/releases/latest/download/$APPIMAGE_NAME"
if command -v curl >/dev/null 2>&1; then
  curl -fL "$URL" -o "$TARGET"
elif command -v wget >/dev/null 2>&1; then
  wget -q "$URL" -O "$TARGET"
else
  echo "Нужен curl или wget для скачивания."; exit 1
fi
chmod +x "$TARGET"
exec "$TARGET"