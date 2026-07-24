/**
 * @fileoverview Серверная часть игры Свечебот
 * 
 * @description
 * Мультиплеерная 2D-игра с роботами и системой свечек.
 * Сервер управляет состоянием игры, синхронизацией и накоплениями.
 * 
 * @see CONCEPT.md - Полная документация по игре
 */

const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// Конфигурация игры
const CONFIG = {
    PORT: 3000,
    DAY_DURATION: 5 * 60 * 1000, // 5 минут в миллисекундах
    NIGHT_DURATION: 5 * 60 * 1000,
    SYNC_INTERVAL: 30000, // 30 секунд
    PLAYERS_DIR: path.join(__dirname, '../players')
};

/**
 * Хэш-функция для генерации предсказуемого значения из ID
 * @param {string} str - Входная строка (ID игрока)
 * @returns {number} - Хэш-значение
 */
function hashCode(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        const char = str.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash; // Convert to 32bit integer
    }
    return Math.abs(hash);
}

/**
 * Генерация начальных карт на основе ID игрока
 * @description
 * Карты предсказуемы на основе ID. Каждый игрок получает
 * уникальный, но воспроизводимый набор карт.
 * 
 * @param {string} playerId - ID игрока
 * @returns {Object} - Объект с количеством карт каждого типа
 */
function generateCards(playerId) {
    const seed = hashCode(playerId);
    
    return {
        movement: (seed % 3) + 1,      // 1-3 карты движения
        attack: (seed % 2) + 1,        // 1-2 карты атаки
        resource: (seed % 4) + 1,      // 1-4 карты ресурса
        permission: seed % 2           // 0-1 карты разрешения
    };
}

/**
 * Управление состоянием игры
 * @description
 * Класс GameState отвечает за:
 * - Хранение состояния всех игроков
 * - Управление циклом день/ночь
 * - Синхронизацию времени
 * - Обработку действий
 */
class GameState {
    constructor() {
        this.players = new Map();
        this.time = {
            isDay: true,
            startedAt: Date.now(),
            dayNumber: 1
        };
        this.startDayNightCycle();
    }

    /**
     * Запуск цикла день/ночь
     * @description
     * Каждые DAY_DURATION переключает время суток
     * и уведомляет всех игроков
     */
    startDayNightCycle() {
        setInterval(() => {
            this.time.isDay = !this.time.isDay;
            this.time.startedAt = Date.now();
            
            if (this.time.isDay) {
                this.time.dayNumber++;
                this.onNewDay();
            } else {
                this.onNightStart();
            }
            
            this.broadcastTimeUpdate();
        }, CONFIG.DAY_DURATION);
    }

    /**
     * Обработчик начала нового дня
     * @description
     * При наступлении дня:
     * - Зажигаются свечки (lit)
     * - Обновляются карты ресурсов
     */
    onNewDay() {
        this.players.forEach((player, id) => {
            player.candles.lit++;
            player.lastDayNumber = this.time.dayNumber;
            this.savePlayer(id, player);
        });
    }

    /**
     * Обработчик начала ночи
     * @description
     * При наступлении ночи:
     * - Сбрасываются временные баффы
     * - Начисляются накопления за день
     */
    onNightStart() {
        this.players.forEach((player, id) => {
            // Начисление накоплений за действия в течение дня
            const dayActions = player.dayActions || 0;
            player.accumulated += dayActions;
            player.dayActions = 0;
            
            // Проверка уровня накоплений
            this.checkPermissionLevel(player);
            this.savePlayer(id, player);
        });
    }

    /**
     * Проверка и обновление уровня разрешений
     * @description
     * Уровни разрешений:
     * - Базовый: всегда доступен
     * - Продвинутый: при accumulated >= 5
     * - Элитный: при accumulated >= 15
     * 
     * @param {Object} player - Объект игрока
     */
    checkPermissionLevel(player) {
        player.permissions.basic = true;
        player.permissions.advanced = player.accumulated >= 5;
        player.permissions.elite = player.accumulated >= 15;
    }

    /**
     * Присоединение игрока к игре
     * @description
     * Загружает или создаёт игрока, генерирует карты по ID
     * 
     * @param {string} playerId - ID игрока
     * @param {string} name - Имя робота
     * @returns {Object} - Состояние игрока
     */
    joinGame(playerId, name) {
        let player = this.loadPlayer(playerId);
        
        if (!player) {
            // Новый игрок — генерируем карты по ID
            const cards = generateCards(playerId);
            player = {
                id: playerId,
                name: name || `Робот-${playerId.slice(-4)}`,
                level: 1,
                experience: 0,
                cards: cards,
                permissions: { basic: true, advanced: false, elite: false },
                accumulated: 0,
                candles: { lit: 0, eternal: 0 },
                inventory: [],
                position: { x: Math.floor(Math.random() * 100), y: Math.floor(Math.random() * 100) },
                dayActions: 0,
                lastDayNumber: 1,
                lastSync: Date.now()
            };
        }
        
        this.players.set(playerId, player);
        this.savePlayer(playerId, player);
        
        return player;
    }

    /**
     * Обработка действия игрока
     * @description
     * Выполняет действие и обновляет состояние.
     * Действия потребляют карты и начисляют накопления.
     * 
     * @param {string} playerId - ID игрока
     * @param {Object} action - Действие { type, target }
     * @returns {Object} - Результат действия
     */
    performAction(playerId, action) {
        const player = this.players.get(playerId);
        if (!player) return { error: 'Игрок не найден' };
        
        let result = { success: false };
        
        switch (action.type) {
            case 'move':
                if (player.cards.movement > 0) {
                    player.cards.movement--;
                    player.position = action.target;
                    player.dayActions++;
                    result = { success: true, position: player.position };
                } else {
                    result = { error: 'Нет карт движения' };
                }
                break;
                
            case 'attack':
                if (player.cards.attack > 0) {
                    player.cards.attack--;
                    player.dayActions += 2;
                    result = { success: true, damage: 10 };
                } else {
                    result = { error: 'Нет карт атаки' };
                }
                break;
                
            case 'collect':
                if (player.cards.resource > 0) {
                    player.cards.resource--;
                    player.dayActions++;
                    player.inventory.push('resource');
                    result = { success: true, collected: 'resource' };
                } else {
                    result = { error: 'Нет карт ресурса' };
                }
                break;
                
            case 'unlock':
                if (player.cards.permission > 0 && player.permissions.basic) {
                    player.cards.permission--;
                    player.dayActions += 3;
                    player.candles.eternal++;
                    result = { success: true, unlocked: 'eternal_candle' };
                } else {
                    result = { error: 'Нет карт разрешения или нет базового доступа' };
                }
                break;
        }
        
        this.savePlayer(playerId, player);
        return result;
    }

    /**
     * Синхронизация времени для клиента
     * @description
     * Возвращает текущее время сервера и состояние цикла
     * 
     * @returns {Object} - Информация о времени
     */
    getTimeSync() {
        const elapsed = Date.now() - this.time.startedAt;
        const duration = this.time.isDay ? CONFIG.DAY_DURATION : CONFIG.NIGHT_DURATION;
        const remaining = Math.max(0, duration - elapsed);
        
        return {
            isDay: this.time.isDay,
            dayNumber: this.time.dayNumber,
            remaining: remaining,
            timestamp: Date.now()
        };
    }

    /**
     * Загрузка игрока из JSON-файла
     * @param {string} playerId - ID игрока
     * @returns {Object|null} - Объект игрока или null
     */
    loadPlayer(playerId) {
        const filePath = path.join(CONFIG.PLAYERS_DIR, `${playerId}.json`);
        try {
            if (fs.existsSync(filePath)) {
                const data = fs.readFileSync(filePath, 'utf8');
                return JSON.parse(data);
            }
        } catch (e) {
            console.error(`Ошибка загрузки игрока ${playerId}:`, e);
        }
        return null;
    }

    /**
     * Сохранение игрока в JSON-файл
     * @param {string} playerId - ID игрока
     * @param {Object} player - Объект игрока
     */
    savePlayer(playerId, player) {
        const filePath = path.join(CONFIG.PLAYERS_DIR, `${playerId}.json`);
        try {
            fs.writeFileSync(filePath, JSON.stringify(player, null, 2));
        } catch (e) {
            console.error(`Ошибка сохранения игрока ${playerId}:`, e);
        }
    }

    /**
     * Отправка обновления времени всем подключённым игрокам
     */
    broadcastTimeUpdate() {
        const timeData = this.getTimeSync();
        wss.clients.forEach(client => {
            if (client.readyState === 1) {
                client.send(JSON.stringify({ type: 'timeUpdate', data: timeData }));
            }
        });
    }
}

// Инициализация состояния игры
const gameState = new GameState();

// HTTP маршруты
app.use(express.static(path.join(__dirname, '../client')));

app.get('/api/time', (req, res) => {
    res.json(gameState.getTimeSync());
});

app.get('/api/state/:playerId', (req, res) => {
    const player = gameState.players.get(req.params.playerId);
    if (player) {
        res.json(player);
    } else {
        res.status(404).json({ error: 'Игрок не найден' });
    }
});

// WebSocket обработка
wss.on('connection', (ws) => {
    console.log('Новое подключение');
    let currentPlayerId = null;

    ws.on('message', (data) => {
        try {
            const message = JSON.parse(data);
            
            switch (message.type) {
                case 'join':
                    const player = gameState.joinGame(message.id, message.name);
                    currentPlayerId = message.id;
                    ws.send(JSON.stringify({ type: 'joined', data: player }));
                    break;
                    
                case 'action':
                    if (currentPlayerId) {
                        const result = gameState.performAction(currentPlayerId, message.action);
                        ws.send(JSON.stringify({ type: 'actionResult', data: result }));
                        
                        // Обновляем карты в реальном времени
                        const updatedPlayer = gameState.players.get(currentPlayerId);
                        ws.send(JSON.stringify({ type: 'playerUpdate', data: updatedPlayer }));
                    }
                    break;
                    
                case 'sync':
                    ws.send(JSON.stringify({ type: 'timeSync', data: gameState.getTimeSync() }));
                    break;
            }
        } catch (e) {
            console.error('Ошибка обработки сообщения:', e);
        }
    });

    ws.on('close', () => {
        console.log('Клиент отключился');
    });
});

// Запуск сервера
server.listen(CONFIG.PORT, () => {
    console.log(`Свечебот сервер запущен на порту ${CONFIG.PORT}`);
    console.log(`Игровой день: ${CONFIG.DAY_DURATION / 1000} секунд`);
});
