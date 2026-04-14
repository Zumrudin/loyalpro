# gluestack-ui Setup Guide

## Что установлено

✅ **@gluestack-ui/themed** — основная библиотека UI компонентов для React Native
✅ **@gluestack-ui/config** — система конфигурации и тем
✅ **Custom theme** — созданa с цветами вашего приложения

## Как использовать

### 1. Базовые компоненты из gluestack-ui

```jsx
import {
  Box,           // Контейнер (как View)
  VStack,        // Вертикальный layout (flex-column)
  HStack,        // Горизонтальный layout (flex-row)
  Text,          // Текст
  Heading,       // Заголовок
  Button,        // Кнопка
  Input,         // Инпут
  Card,          // Карточка
  Modal,         // Модальное окно
  Toast,         // Уведомление внизу экрана
  Spinner,       // Лоадер
  Badge,         // Бейдж
  Divider,       // Разделитель
  Image,         // Картинка
  ScrollView,    // Прокручиваемый контейнер
} from '@gluestack-ui/themed';
```

### 2. Примеры использования

#### Box (контейнер)
```jsx
import { Box, Text } from '@gluestack-ui/themed';

<Box bg="$surface" p="$4" borderRadius="$lg">
  <Text>Содержимое</Text>
</Box>
```

#### VStack / HStack (макет)
```jsx
import { VStack, HStack, Text } from '@gluestack-ui/themed';

// Вертикальный
<VStack space="$4">
  <Text>Элемент 1</Text>
  <Text>Элемент 2</Text>
</VStack>

// Горизонтальный
<HStack space="$2">
  <Text>Левый</Text>
  <Text>Правый</Text>
</HStack>
```

#### Текст
```jsx
import { Heading, Text } from '@gluestack-ui/themed';

<Heading size="lg">Большой заголовок</Heading>
<Text color="$textLight">Обычный текст</Text>
```

#### Кнопка
```jsx
import { Button, ButtonText } from '@gluestack-ui/themed';

<Button onPress={() => alert('Нажато')}>
  <ButtonText>Нажми меня</ButtonText>
</Button>
```

### 3. Цветовая система

Доступные цвета из конфига:

```
Основные цвета:
- primary (золото #D4AF37) и оттенки primary100-900
- background (кремовый #F5F3F0)
- surface (белый #FFFFFF)

Текст:
- $text (#4A4540) — основной текст
- $textLight (60% прозрачности) — вторичный текст
- $textLighter (40% прозрачности) — третичный текст

Статусы:
- $error (#C62E65) — ошибки
- $success (#4CAF50) — успех
- $warning (#FF9800) — предупреждение
- $info (#2196F3) — информация
```

### 4. Spacing токены

```
$1 = 4px
$2 = 8px
$3 = 12px
$4 = 16px
$5 = 20px
$6 = 24px
$8 = 32px
$12 = 48px
$16 = 64px
```

Используй в свойствах: `p="$4"` (padding), `m="$2"` (margin), `gap="$3"` (промежуток), и т.д.

### 5. Размеры шрифтов

```
- size="xs"   (12px)
- size="sm"   (14px)
- size="md"   (16px)
- size="lg"   (18px)
- size="xl"   (20px)
- size="2xl"  (24px)
```

### 6. Пользовательские компоненты (готовые обёртки)

Созданы оптимизированные компоненты в `/src/components`:

```jsx
import Button from './components/Button';
import Card from './components/Card';
import Input from './components/Input';

// Кнопка
<Button
  label="Отправить"
  onPress={() => {}}
  variant="solid"  // или "outline"
  size="lg"        // sm, md, lg
  icon="heart"
/>

// Карточка
<Card title="Заголовок" subtitle="Подзаголовок">
  <Text>Содержимое карточки</Text>
</Card>

// Инпут
<Input
  label="Email"
  placeholder="example@mail.com"
  value={email}
  onChangeText={setEmail}
  icon="mail"
  error={emailError}
/>
```

### 7. Responsive дизайн

Некоторые свойства можно менять по размеру экрана:

```jsx
<Box
  width={{ '@base': '100%', '@md': '50%', '@lg': '33%' }}
  p={{ '@base': '$2', '@md': '$4', '@lg': '$6' }}
>
  Адаптивный контент
</Box>
```

### 8. Тёмная тема (опционально)

По умолчанию светлая тема. Для переключения на тёмную:

```jsx
import { useColorMode } from '@gluestack-ui/themed';

function MyComponent() {
  const { toggleColorMode, colorMode } = useColorMode();

  return (
    <Button onPress={toggleColorMode}>
      <ButtonText>
        Сейчас {colorMode} режим
      </ButtonText>
    </Button>
  );
}
```

## Дополнительные ресурсы

- Документация: https://gluestack.io/ui/docs/home/overview/introduction
- Компоненты: https://gluestack.io/ui/docs/components
- Примеры кода: https://gluestack.io/ui/docs/components/box

## Когда использовать какой компонент

| Случай | Компонент |
|---|---|
| Контейнер/блок | `Box` |
| Вертикальный список | `VStack` |
| Горизонтальное расположение | `HStack` |
| Заголовок/название | `Heading` |
| Обычный текст | `Text` |
| Действие пользователя | `Button` |
| Ввод данных | `Input` |
| Группа информации | `Card` |
| Появляющееся окно | `Modal` |
| Уведомление | `Toast` или `Alert` |
| Ожидание | `Spinner` |

## Tips & Tricks

1. **Shadows** — `shadow="soft"`, `shadow="hard"`, `shadow="none"`
2. **Border radius** — `$xs`, `$sm`, `$md`, `$lg`, `$xl`, `$full`
3. **Font weight** — `$400`, `$500`, `$600`, `$700`, `$900`
4. **Opacity** — прямо в цвете: `rgba(212, 175, 55, 0.5)`
5. **Margin auto** — `m="auto"` для центрирования

Начни заменять компоненты в своих экранах! Например, в LoginScreen замени обычные TextInput на наши `Input` компоненты.
