# Dream Skin 适配

Dream Skin 需自行安装，本项目不捆绑其程序。适配器在已有的 `loadPayload` 中加入加载钩子，并保留原文件备份与哈希校验。

## 使用默认壁纸＋八小只

1. 从 Release 下载完整包及 `white-dragon-lavender-1.0.0.zip`。
2. 将完整包解压到长期保留的目录。
3. 从 Dream Skin 的主题导入入口导入主题 ZIP，选择“白龙娘 · 浅紫”。
4. 在普通桌面 PowerShell 中进入完整包目录，执行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy RemoteSigned -File .\scripts\install-dream-skin-extension.ps1
```

5. 从 Dream Skin 托盘应用或重新应用。

主题包复用当前白龙娘图片和浅紫配色；Codex 的页面结构由宿主负责，不同宿主版本可能有细节差别。

## 使用其他背景或部分角色

角色适配器不指定、替换壁纸。直接在 Dream Skin 切换其他主题，再重新应用即可。

编辑根目录 `companion-settings.json`，选择角色及排列顺序，例如：

```json
{
  "characters": ["big-fish", "gpt"],
  "layout": { "characterWidth": 56, "gap": -8, "rightInset": 8, "overlap": 3 }
}
```

重新应用后生效。可用 ID 见主 README。

## 更新、暂停与撤回

在同一目录更新项目文件，再重新应用。移动目录或 Dream Skin 升级替换注入文件后需要重新安装。若脚本提示 MSIX 重定向，请在普通桌面 PowerShell 中运行。

暂停 Dream Skin 会同时隐藏同伴。撤回：

```powershell
node scripts/apply-companions.mjs --remove
powershell.exe -NoProfile -ExecutionPolicy RemoteSigned -File .\scripts\install-dream-skin-extension.ps1 -Uninstall
```

撤回会检查收据和哈希；发现后续修改时停止覆盖。本机安装收据在 `integration/install-state/`，不应上传。

本项目不添加任何开机自启设置，也不负责自动启动或重启 Codex。
