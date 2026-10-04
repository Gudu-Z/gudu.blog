# Gudu 的个人博客

目前只实现 Hero 首屏：包豪斯几何、深色太空、左上两行标题与实时日期时间、接近侧视的倾斜黑洞特写，以及鼠标视差。页面仅保留标题和时钟文字。

## 线上访问

[打开 Gudu 的个人博客](https://gudu-z.github.io/gudu.blog/)

GitHub Pages 从 `main` 分支的根目录发布，推送更新后自动部署。`.nojekyll` 让页面和静态资源直接发布。

## 本地预览

需要 Node.js 18 或更新版本，无需安装依赖：

```sh
npm run dev
```

打开 http://localhost:4173 。也可以直接打开 `index.html`，所有视觉资源均在本地，不依赖 CDN。

## 结构

- `index.html`：语义结构及文字。
- `css/style.css`：首屏布局、桌面与移动端适配。
- `js/black-hole.js`：WebGL 光线积分、吸积盘着色与泛光。
- `js/main.js`：本地时钟、星空、视差与动画生命周期。

## 黑洞视觉

吸积盘倾角为 81°，指盘面法线与视线的夹角，盘面接近侧视。画面中的斜向构图单独控制，两者相互独立。

着色器在三维空间积分 Schwarzschild 光线轨迹，捕获进入视界的光线，并计算光线与薄吸积盘的交点。因此阴影、透镜像和高阶细环由光路形成。盘内缘为 3 倍 Schwarzschild 半径；轨道速度、多普勒频移与引力红移共同影响颜色及亮度。使用动漫风格色板、细线纹理和柔和泛光。

这是用于实时网页的有限步长可视化，颜色经过艺术处理，不是完整的 Kerr 黑洞或科学辐射转移模拟。物理形态参考 [NASA 黑洞可视化](https://www.nasa.gov/universe/nasa-visualization-shows-a-black-holes-warped-world/) 与 [NASA 黑洞结构](https://science.nasa.gov/universe/black-holes/anatomy/)。

动画自动播放，并遵循系统减少动态效果偏好；页面不可见时停止绘制。支持分辨率自适应，以及 WebGL 不可用或上下文丢失时的静态插画回退。仅渲染首屏内可见的画面，以保持清晰度并避免绘制屏幕外的区域。移动端不拦截触摸滚动。

时钟采用访问者设备的本地时区，每秒读取真实时间；与视觉动画独立更新，返回页面时立即校时。

## 检查

```sh
npm run check
```
