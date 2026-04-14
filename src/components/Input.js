import React, { useState } from 'react';
import {
  View,
  Text,
  TextInput,
  StyleSheet,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';

export default function Input({
  label,
  placeholder,
  value,
  onChangeText,
  icon = null,
  type = 'text',
  error = null,
  disabled = false,
  style,
  ...props
}) {
  const [isFocused, setIsFocused] = useState(false);

  return (
    <View style={[styles.wrapper, style]}>
      {label && (
        <Text style={[styles.label, error && styles.labelError]}>{label}</Text>
      )}
      <View
        style={[
          styles.inputRow,
          isFocused && styles.inputFocused,
          error && styles.inputError,
          disabled && styles.inputDisabled,
        ]}
      >
        {icon && (
          <Ionicons
            name={icon}
            size={18}
            color={error ? '#E53E3E' : isFocused ? '#D4AF37' : '#8A7F78'}
            style={styles.icon}
          />
        )}
        <TextInput
          placeholder={placeholder}
          value={value}
          onChangeText={onChangeText}
          secureTextEntry={type === 'password'}
          keyboardType={type === 'email' ? 'email-address' : type === 'phone' ? 'phone-pad' : 'default'}
          editable={!disabled}
          placeholderTextColor="#B0A89F"
          onFocus={() => setIsFocused(true)}
          onBlur={() => setIsFocused(false)}
          style={styles.textInput}
          {...props}
        />
      </View>
      {error && <Text style={styles.errorText}>{error}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    marginBottom: 4,
  },
  label: {
    fontSize: 13,
    fontWeight: '600',
    color: '#4A4540',
    marginBottom: 6,
  },
  labelError: {
    color: '#E53E3E',
  },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#E8E0D5',
    borderRadius: 10,
    backgroundColor: '#FAFAF8',
    paddingHorizontal: 12,
    height: 48,
  },
  inputFocused: {
    borderColor: '#D4AF37',
    borderWidth: 1.5,
  },
  inputError: {
    borderColor: '#E53E3E',
    borderWidth: 2,
  },
  inputDisabled: {
    opacity: 0.5,
    backgroundColor: '#F0EDE8',
  },
  icon: {
    marginRight: 8,
  },
  textInput: {
    flex: 1,
    fontSize: 15,
    color: '#2C2825',
  },
  errorText: {
    fontSize: 12,
    color: '#E53E3E',
    marginTop: 4,
  },
});
