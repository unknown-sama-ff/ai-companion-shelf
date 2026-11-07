# 网页与其他宿主接入

从 Release 下载完整或单角色包，复制 `companion-shelf.js`。该文件内嵌图集、配置和默认壁纸，可离线使用。宿主需要支持现代 JavaScript 和 Canvas，WebGL 可选。

```html
<div id="anchor" style="margin-top:100px;height:100px">挂接位置</div>
<script src="companion-shelf.js"></script>
<script>
(async () => {
  const shelf = await CompanionShelf.mount({
    target: '#anchor', characters: ['claude', 'kimi'],
    layout: { characterWidth: 56, gap: -8, rightInset: 8, overlap: 3 }
  });
  shelf.setActive('kimi', true);
  // shelf.setActive('kimi', false); // 正常收尾
  // shelf.refresh();              // 重新寻找挂接容器
  // shelf.destroy();              // 清理元素、观察器、纹理和帧调度
})();
</script>
```

`target` 可为 CSS 选择器或元素。动态页面建议使用选择器，也可传 `getTarget: () => yourCurrentElement`。省略目标时尝试寻找输入区域。

`characters` 省略时显示该包所有角色，指定时按数组顺序排列，至少一只。单角色包仅包含对应角色。一个页面维护一组同伴；再次 mount 会清理上一组。

## 独立控制背景

`mount` 默认不改页面背景。加 `wallpaper: true` 使用默认白龙娘图片，或传 `wallpaper: './my-image.jpg'`。已有页面背景时省略这个参数即可。

```js
const restore = CompanionShelf.setWallpaper('./my-background.jpg');
// restore(); // 还原本次写入的背景属性，保留之后由其他代码改过的值
```

默认靠右、按高度适配，避免纵向裁切；也可以让宿主自行管理背景 CSS。传递文本、路径时使用 API 参数，不要把不可信字符串插入 HTML 或脚本。

## 源码形式

在 HTTP 服务上引入 `src/companions.js` 和 `src/shelf.js`，保留 `assets/`、`themes/` 的相对位置后调用 mount。API 会读取 JSON 清单并解析 PNG 地址，可用 `baseUrl` 指定资源目录。未构建源码不支持直接通过 `file://` 读取清单；离线双击请用 Release 包。

也可传 `data: {characters, images}` 使用自己的图集。底层运行时仍叫 `CodexCompanions.install(config)`，保留这个历史名称以兼容已有适配器。

## 原生桌面软件

本项目不会自动注入任意原生应用。跨应用桌宠需要自己的透明窗口壳负责置顶、位置和鼠标穿透，可在 WebView 中运行本组件，也可复用 PNG 和动作清单。
