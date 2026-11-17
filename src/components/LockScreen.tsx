import React, { useState } from 'react';
import { Input, Button, Alert } from 'antd';
import { LockOutlined } from '@ant-design/icons';

type Props = {
  hasPin: boolean;
  onUnlock: (pin: string) => Promise<boolean>;
};

export default function LockScreen({ hasPin, onUnlock }: Props) {
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!pin) {
      setError('请输入密码');
      return;
    }
    setBusy(true);
    setError('');
    const ok = await onUnlock(pin);
    setBusy(false);
    if (!ok) {
      setError('密码不对');
      setPin('');
    }
  };

  return (
    <div className="lock-screen">
      <div className="lock-card">
        <div className="lock-mark">
          <LockOutlined />
        </div>
        <div style={{ fontSize: 16, fontWeight: 600 }}>测试工作台已锁定</div>
        <div style={{ color: '#7b8296', fontSize: 12.5, marginTop: 6, marginBottom: 18 }}>
          {hasPin ? '输入密码继续使用' : '点击进入'}
        </div>

        {error ? (
          <Alert type="error" showIcon message={error} style={{ marginBottom: 12, textAlign: 'left' }} />
        ) : null}

        <Input.Password
          size="large"
          autoFocus
          placeholder="密码"
          value={pin}
          onChange={(e) => setPin(e.target.value)}
          onPressEnter={submit}
          style={{ marginBottom: 12, textAlign: 'center' }}
        />
        <Button type="primary" size="large" block loading={busy} onClick={submit}>
          解锁
        </Button>
      </div>
    </div>
  );
}