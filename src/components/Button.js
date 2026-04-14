import React from 'react';
import {
  TouchableOpacity,
  Text,
  StyleSheet,
  ActivityIndicator,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';

export default function Button({
  label,
  onPress,
  variant = 'solid',
  size = 'md',
  icon = null,
  disabled = false,
  loading = false,
  style,
  ...props
}) {
  const sizeStyles = {
    sm: { paddingHorizontal: 12, paddingVertical: 8, fontSize: 13 },
    md: { paddingHorizontal: 16, paddingVertical: 12, fontSize: 15 },
    lg: { paddingHorizontal: 20, paddingVertical: 14, fontSize: 16 },
  };

  const isSolid = variant === 'solid';

  return (
    <TouchableOpacity
      onPress={onPress}
      disabled={disabled || loading}
      activeOpacity={0.75}
      style={[
        styles.base,
        {
          paddingHorizontal: sizeStyles[size].paddingHorizontal,
          paddingVertical: sizeStyles[size].paddingVertical,
          backgroundColor: isSolid ? '#D4AF37' : 'transparent',
          borderWidth: isSolid ? 0 : 1,
          borderColor: '#D4AF37',
          opacity: disabled ? 0.5 : 1,
        },
        style,
      ]}
      {...props}
    >
      {loading ? (
        <ActivityIndicator color={isSolid ? '#fff' : '#D4AF37'} size="small" />
      ) : (
        <View style={styles.inner}>
          {icon && (
            <Ionicons
              name={icon}
              size={sizeStyles[size].fontSize}
              color={isSolid ? '#fff' : '#D4AF37'}
              style={styles.icon}
            />
          )}
          <Text
            style={[
              styles.label,
              {
                fontSize: sizeStyles[size].fontSize,
                color: isSolid ? '#fff' : '#D4AF37',
              },
            ]}
          >
            {label}
          </Text>
        </View>
      )}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  base: {
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  inner: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  icon: {
    marginRight: 6,
  },
  label: {
    fontWeight: '600',
  },
});
