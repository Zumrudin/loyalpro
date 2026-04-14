import React, { useState, useEffect, useRef } from 'react';
import {
  View,
  TextInput,
  TouchableOpacity,
  Text,
  StyleSheet,
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  Linking,
} from 'react-native';
import { useAuthStore } from '../store/authStore';

const RESEND_TIMEOUT = 60;

export default function LoginScreen({ navigation }) {
  const [phone, setPhone] = useState('');
  const [step, setStep] = useState('phone'); // 'phone' | 'otp'
  const [otp, setOtp] = useState('');
  const [countdown, setCountdown] = useState(0);
  const timerRef = useRef(null);

  const isLoading = useAuthStore((state) => state.isLoading);
  const error = useAuthStore((state) => state.error);
  const telegramLink = useAuthStore((state) => state.telegramLink);
  const login = useAuthStore((state) => state.login);
  const verifyOtp = useAuthStore((state) => state.verifyOtp);

  useEffect(() => {
    return () => clearInterval(timerRef.current);
  }, []);

  const startCountdown = () => {
    setCountdown(RESEND_TIMEOUT);
    clearInterval(timerRef.current);
    timerRef.current = setInterval(() => {
      setCountdown((prev) => {
        if (prev <= 1) {
          clearInterval(timerRef.current);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
  };

  const handlePhoneSubmit = async () => {
    const digits = phone.replace(/\D/g, '');
    if (digits.length < 10) {
      Alert.alert('Ошибка', 'Введите корректный номер телефона');
      return;
    }

    const result = await login(phone);
    if (result.success) {
      setStep('otp');
      setOtp('');
      startCountdown();
    } else {
      Alert.alert('Ошибка', result.message);
    }
  };

  const handleResend = async () => {
    const result = await login(phone);
    if (result.success) {
      setOtp('');
      startCountdown();
    } else {
      Alert.alert('Ошибка', result.message);
    }
  };

  const handleOtpSubmit = async () => {
    if (otp.length < 4) {
      Alert.alert('Ошибка', 'Введите 4-значный код');
      return;
    }

    const result = await verifyOtp(phone, otp);
    if (!result.success) {
      Alert.alert('Ошибка', result.message);
    }
  };

  const handleBack = () => {
    clearInterval(timerRef.current);
    setStep('phone');
    setOtp('');
    setCountdown(0);
  };

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      style={styles.container}
    >
      <View style={styles.content}>
        <Text style={styles.title}>Добро пожаловать</Text>

        {step === 'phone' ? (
          <>
            <Text style={styles.subtitle}>Введите номер телефона</Text>
            <TextInput
              style={styles.input}
              placeholder="+7 (999) 999-99-99"
              placeholderTextColor="#999"
              keyboardType="phone-pad"
              value={phone}
              onChangeText={setPhone}
              editable={!isLoading}
              autoFocus
            />
            <TouchableOpacity
              style={[styles.button, isLoading && styles.buttonDisabled]}
              onPress={handlePhoneSubmit}
              disabled={isLoading}
            >
              {isLoading ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <Text style={styles.buttonText}>Получить код</Text>
              )}
            </TouchableOpacity>
          </>
        ) : (
          <>
            <Text style={styles.subtitle}>
              Код отправлен на номер{'\n'}
              <Text style={styles.phoneHighlight}>{phone}</Text>
            </Text>
            <TextInput
              style={[styles.input, styles.otpInput]}
              placeholder="- - - -"
              placeholderTextColor="#999"
              keyboardType="number-pad"
              maxLength={4}
              value={otp}
              onChangeText={setOtp}
              editable={!isLoading}
              autoFocus
            />
            <TouchableOpacity
              style={[styles.button, (isLoading || otp.length < 4) && styles.buttonDisabled]}
              onPress={handleOtpSubmit}
              disabled={isLoading || otp.length < 4}
            >
              {isLoading ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <Text style={styles.buttonText}>Войти</Text>
              )}
            </TouchableOpacity>

            {telegramLink ? (
              <TouchableOpacity
                style={styles.telegramButton}
                onPress={() => Linking.openURL(telegramLink)}
              >
                <Text style={styles.telegramButtonText}>Открыть Telegram и получить код</Text>
              </TouchableOpacity>
            ) : null}

            <View style={styles.resendContainer}>
              {countdown > 0 ? (
                <Text style={styles.countdownText}>
                  Отправить повторно через {countdown} сек.
                </Text>
              ) : (
                <TouchableOpacity onPress={handleResend} disabled={isLoading}>
                  <Text style={styles.link}>Отправить код повторно</Text>
                </TouchableOpacity>
              )}
            </View>

            <TouchableOpacity onPress={handleBack} style={styles.backButton}>
              <Text style={styles.backText}>Изменить номер телефона</Text>
            </TouchableOpacity>
          </>
        )}

        {error ? <Text style={styles.errorText}>{error}</Text> : null}
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f5f5f5',
  },
  content: {
    flex: 1,
    justifyContent: 'center',
    paddingHorizontal: 24,
  },
  title: {
    fontSize: 28,
    fontWeight: 'bold',
    marginBottom: 10,
    color: '#000',
  },
  subtitle: {
    fontSize: 16,
    color: '#666',
    marginBottom: 28,
    lineHeight: 22,
  },
  phoneHighlight: {
    color: '#000',
    fontWeight: '600',
  },
  input: {
    backgroundColor: '#fff',
    borderRadius: 8,
    paddingHorizontal: 15,
    paddingVertical: 13,
    marginBottom: 15,
    fontSize: 16,
    borderWidth: 1,
    borderColor: '#ddd',
  },
  otpInput: {
    fontSize: 24,
    letterSpacing: 8,
    textAlign: 'center',
  },
  button: {
    backgroundColor: '#007AFF',
    borderRadius: 8,
    paddingVertical: 13,
    alignItems: 'center',
    marginTop: 4,
  },
  buttonDisabled: {
    backgroundColor: '#ccc',
  },
  buttonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  resendContainer: {
    marginTop: 20,
    alignItems: 'center',
  },
  countdownText: {
    color: '#999',
    fontSize: 14,
  },
  link: {
    color: '#007AFF',
    fontSize: 14,
  },
  telegramButton: {
    backgroundColor: '#2AABEE',
    borderRadius: 8,
    paddingVertical: 13,
    alignItems: 'center',
    marginTop: 16,
  },
  telegramButtonText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '600',
  },
  backButton: {
    marginTop: 12,
    alignItems: 'center',
  },
  backText: {
    color: '#666',
    fontSize: 14,
    textDecorationLine: 'underline',
  },
  errorText: {
    color: '#ff3b30',
    textAlign: 'center',
    marginTop: 16,
    fontSize: 14,
  },
});
