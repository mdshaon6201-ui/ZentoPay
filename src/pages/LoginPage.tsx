import React from 'react';
import { AuthShellScreens } from '../components/ewallet/AuthShellScreens.tsx';

export function LoginPage() {
  return <AuthShellScreens initialMode="login" />;
}
