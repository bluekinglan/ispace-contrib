/**
 * 头像在上传前先缩到这个见方。
 *
 * 在浏览器里缩，而不是在服务端：服务端缩要装 sharp（原生依赖，Docker 构建
 * 多一层会失败的东西），而头像恰好是最适合在前端处理的——用户的图就在他
 * 自己机器上，缩完再传还省了上行带宽。几 MB 的手机原图传上来变成几十 KB。
 *
 * 256 够用：全站最大的头像是这个弹层里的 96px，二倍屏上 192px。
 */
export const AVATAR_PX = 256;

/**
 * 把用户选的图缩成一张方头像。
 *
 * 居中裁切而不是拉伸：人像照多半是竖的，拉伸会把脸压扁，而裁切顶多切掉
 * 两边的背景。
 */
export async function squareAvatar(file: File): Promise<Blob> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((res, rej) => {
      const im = new Image();
      im.onload = () => res(im);
      im.onerror = () => rej(new Error('这个文件不是图片，或者已经损坏'));
      im.src = url;
    });
    const side = Math.min(img.naturalWidth, img.naturalHeight);
    if (!side) throw new Error('这个文件不是图片，或者已经损坏');

    const cv = document.createElement('canvas');
    cv.width = AVATAR_PX; cv.height = AVATAR_PX;
    const ctx = cv.getContext('2d')!;
    ctx.drawImage(
      img,
      (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side,
      0, 0, AVATAR_PX, AVATAR_PX,
    );

    /*
      要 webp，但不强求：Safari 到 16 才支持 toBlob 导出 webp，更早的版本
      会**静默回落成 PNG**。PNG 也在服务端白名单里，所以不必特判——只在
      真的什么都拿不到时才报错。
    */
    const blob = await new Promise<Blob | null>((res) => {
      cv.toBlob(res, 'image/webp', 0.9);
    });
    if (!blob) throw new Error('这张图处理不了，换一张试试');
    return blob;
  } finally {
    URL.revokeObjectURL(url);
  }
}
