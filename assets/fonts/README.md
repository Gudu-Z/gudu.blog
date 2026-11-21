# 标题字体

- `barlow-condensed-black-latin.woff2`：Barlow Condensed Black，来自 Google Fonts，许可见 `OFL-Barlow.txt`。
- `rajdhani-semibold.ttf`：Rajdhani SemiBold，Google Fonts 提供的英文字母、数字及 ` /—` 字符子集，用于分类区，许可见 `OFL-Rajdhani.txt`。
- `noto-sans-sc-categories-bold.ttf`：Noto Sans SC Bold，Google Fonts 提供的“分类白日梦话神秘文案其他”字符子集，仅用于分类标题，许可见 `OFL-NotoSansSC.txt`。
- `articles/`：Noto Sans SC 的逐篇子集，每篇三份：标题（Black，只含标题用到的字）、正文常规和正文半粗（只含正文用到的汉字和中文标点）。由 `npm run build` 从本机的 Noto Sans SC 可变字体裁出（`scripts/article-fonts.mjs`），不要手工修改，许可见 `OFL-NotoSansSC.txt`。
