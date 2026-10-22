import { useEffect, useRef, useState } from 'react';
import { BackHandler, Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { API_BASE } from '../config';

/**
 * 扫一扫（「我」左上角那颗）。
 *
 * 电脑上看到一个页面想在手机上用，扫它的地址二维码就在壳里打开——走壳的
 * 登录态，不用在手机浏览器里再登一遍。认得出的只有本平台的地址；别家的
 * 链接说一句是什么，给一颗「用浏览器打开」，不在壳里开陌生网页。
 *
 * 登录用的那种码（ispace-login:…）也会被扫到：已经登录了，说一句就好。
 */
export function ScanScreen({
  onClose, onOpenPath,
}: {
  onClose: () => void;
  onOpenPath: (path: string) => void;
}) {
  const insets = useSafeAreaInsets();
  const [permission, requestPermission] = useCameraPermissions();
  const [msg, setMsg] = useState<string | null>(null);
  const [foreign, setForeign] = useState<string | null>(null);
  // 相机每秒回调几十次同一个码，锁住第一个
  const locked = useRef(false);

  useEffect(() => {
    if (permission && !permission.granted && permission.canAskAgain) void requestPermission();
  }, [permission, requestPermission]);

  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => { onClose(); return true; });
    return () => sub.remove();
  }, [onClose]);

  const onScanned = (data: string) => {
    if (locked.current) return;
    locked.current = true;
    setTimeout(() => { locked.current = false; }, 2000);

    if (data.startsWith('ispace-login:')) {
      setMsg('这是电脑上的登录码。你已经登录了，不用扫它。');
      return;
    }
    const origin = API_BASE.replace(/^(https?:\/\/[^/]+).*$/, '$1');
    if (data.startsWith(origin)) {
      const path = data.slice(origin.length) || '/';
      onOpenPath(path.startsWith('/') ? path : `/${path}`);
      return;
    }
    if (/^https?:\/\//.test(data)) {
      setForeign(data);
      setMsg('这不是 iSpace 的页面。');
      return;
    }
    setMsg(`扫到的是一段文字：${data.slice(0, 80)}`);
  };

  return (
    <View style={{ flex: 1, backgroundColor: '#000' }}>
      {permission?.granted ? (
        <CameraView
          style={{ flex: 1 }}
          facing="back"
          barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
          onBarcodeScanned={({ data }) => onScanned(data)}
        />
      ) : (
        <View style={s.center}>
          <Text style={s.text}>
            需要相机权限才能扫码。{'\n'}
            {permission?.canAskAgain === false ? '请到系统设置里给 iSpace 打开相机权限。' : '正在请求权限…'}
          </Text>
        </View>
      )}

      <View style={[s.top, { top: insets.top + 16 }]}>
        <Text style={s.title}>扫一扫</Text>
        <Text style={s.sub}>对准电脑上页面的二维码，在手机上打开它</Text>
        {msg && <Text style={s.msg}>{msg}</Text>}
        {foreign && (
          <Pressable style={s.btn} onPress={() => void Linking.openURL(foreign)}>
            <Text style={s.btnText}>用浏览器打开</Text>
          </Pressable>
        )}
      </View>
      <View style={[s.bottom, { bottom: insets.bottom + 24 }]}>
        <Pressable style={s.btn} onPress={onClose}>
          <Text style={s.btnText}>取消</Text>
        </Pressable>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 },
  text: { color: '#fff', fontSize: 15, textAlign: 'center', lineHeight: 24 },
  top: { position: 'absolute', left: 0, right: 0, alignItems: 'center', gap: 10, paddingHorizontal: 32 },
  title: { color: '#fff', fontSize: 17, fontWeight: '700' },
  sub: { color: 'rgba(255,255,255,.75)', fontSize: 13, textAlign: 'center' },
  msg: { color: '#ffb4a1', fontSize: 14, textAlign: 'center', lineHeight: 21 },
  bottom: { position: 'absolute', left: 0, right: 0, alignItems: 'center' },
  btn: { paddingVertical: 12, paddingHorizontal: 32, borderRadius: 24, backgroundColor: 'rgba(255,255,255,.18)' },
  btnText: { color: '#fff', fontSize: 15 },
});
