# Свечебот — Документация

## Установка

### Сервер
```bash
cd server
npm install
npm start
```

### Клиент
Откройте `client/index.html` в браузере.

## Архитектура

### Серверная часть (server.js)
- **Express** — HTTP сервер
- **WebSocket** — real-time коммуникация
- **GameState** — управление состоянием игры

### Клиентская часть (index.html)
- **Canvas** — рендеринг 2D графики
- **WebSocket Client** — подключение к серверу
- **GameEngine** — игровой цикл

## Механики

### Система Свечек
```
День (5 мин) → Ночь (5 мин) → День...
```

### Карточки Доступа
| Тип | Описание | Лимит |
|-----|----------|-------|
| Движение | Перемещение по карте | 1-3 |
| Атака | Боевые действия | 1-2 |
| Ресурс | Добыча ресурсов | 1-4 |
| Разрешение | Доступ к зонам | 0-1 |

### Накопления
```javascript
accumulated += action_value;
if (accumulated >= 5) unlockAdvanced();
if (accumulated >= 15) unlockElite();
```

## API

### POST /join
```json
{
  "id": "player_123",
  "name": "Мой Робот"
}
```

### GET /state
```json
{
  "time": "day",
  "candles": { "lit": 3, "eternal": 1 },
  "players": [...]
}
```

### POST /action
```json
{
  "type": "move",
  "target": { "x": 10, "y": 5 }
}
```

## Файловая структура
```
Свечебот/
├── CONCEPT.md
├── README.md
├── server/
│   ├── package.json
│   └── server.js
├── client/
│   └── index.html
└── players/
    └── [player_id].json
```
