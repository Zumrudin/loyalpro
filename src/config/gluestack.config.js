import { config as defaultConfig } from '@gluestack-ui/config';

// Custom theme colors matching the app design
export const config = {
  ...defaultConfig,
  tokens: {
    ...defaultConfig.tokens,
    colors: {
      ...defaultConfig.tokens.colors,
      primary: '#D4AF37', // Gold
      primary100: '#F5E6D3',
      primary200: '#E8D4A8',
      primary300: '#DBC27D',
      primary400: '#D4AF37',
      primary500: '#C9A027',
      primary600: '#B8891A',
      primary700: '#9E7214',
      primary800: '#6B4E0B',
      primary900: '#3D2C06',

      background: '#F5F3F0', // Cream/beige
      surface: '#FFFFFF',
      surfaceVariant: '#F5F3F0',

      text: '#4A4540', // Dark brown text
      textLight: 'rgba(74,69,64,0.60)',
      textLighter: 'rgba(74,69,64,0.40)',

      error: '#C62E65',
      success: '#4CAF50',
      warning: '#FF9800',
      info: '#2196F3',
    },
  },
};

export default config;
