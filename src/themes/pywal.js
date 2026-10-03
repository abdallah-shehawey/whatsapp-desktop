/*
 * Dynamic system color detection (Pywal, Wallust, Hyprland).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

/**
 * Detect dynamic system colors from Hyprland/Pywal environment.
 */
function detectHyprlandColors() {
  const home = os.homedir();

  // 1. Check pywal / wallust colors.json
  const walPath = path.join(home, '.cache', 'wal', 'colors.json');
  try {
    if (fs.existsSync(walPath)) {
      const data = JSON.parse(fs.readFileSync(walPath, 'utf8'));
      if (data && data.colors && data.colors.color1) {
        return {
          source: 'pywal',
          accent: data.colors.color4 || data.colors.color1,
          bg: (data.special && data.special.background) || data.colors.color0,
          text: (data.special && data.special.foreground) || data.colors.color7,
          palette: Object.values(data.colors).slice(0, 8),
        };
      }
    }
  } catch (e) {}

  // 2. Check Hyprland colors.conf
  const hyprColors = path.join(home, '.config', 'hypr', 'colors.conf');
  try {
    if (fs.existsSync(hyprColors)) {
      const text = fs.readFileSync(hyprColors, 'utf8');
      const accentMatch = text.match(/\$(?:accent|primary|color4)\s*=\s*(?:rgba?\()?([0-9a-fA-F]{6,8})/);
      if (accentMatch) {
        const hex = '#' + accentMatch[1].slice(0, 6);
        return {
          source: 'hyprland-conf',
          accent: hex,
        };
      }
    }
  } catch (e) {}

  return null;
}

module.exports = {
  detectHyprlandColors,
};
