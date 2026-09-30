const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
const scoreEl = document.getElementById('score');
const hiScoreEl = document.getElementById('hi-score');
const overlay = document.getElementById('overlay');
const finalScoreEl = document.getElementById('final-score');
const restartBtn = document.getElementById('restart');

const GRAVITY = 0.6;
const JUMP_FORCE = -12;
const BASE_SPEED = 6;
const MAX_SPEED = 14;
const SPEED_RAMP = 0.0005;
const SPAWN_INTERVAL_MIN = 1000;
const SPAWN_INTERVAL_MAX = 2500;

let dino = { x: 50, y: 130, w: 44, h: 48, vy: 0, grounded: true, frame: 0 };
let obstacles = [];
let groundX = 0;
let speed = BASE_SPEED;
let score = 0;
let hiScore = Number(localStorage.getItem('dino-hi')) || 0;
let lastSpawn = 0;
let nextSpawn = randomSpawn();
let running = false;
let lastTime = 0;

hiScoreEl.textContent = `HI ${hiScore}`;

function randomSpawn() {
  return SPAWN_INTERVAL_MIN + Math.random() * (SPAWN_INTERVAL_MAX - SPAWN_INTERVAL_MIN);
}

function reset() {
  dino = { x: 50, y: 130, w: 44, h: 48, vy: 0, grounded: true, frame: 0 };
  obstacles = [];
  groundX = 0;
  speed = BASE_SPEED;
  score = 0;
  lastSpawn = 0;
  nextSpawn = randomSpawn();
  scoreEl.textContent = score;
  overlay.classList.add('hidden');
  running = true;
}

function spawnObstacle() {
  const type = Math.random() < 0.7 ? 'cactus' : 'bird';
  if (type === 'cactus') {
    const h = 36 + Math.random() * 24;
    obstacles.push({ x: canvas.width, y: 170 - h, w: 20, h, type: 'cactus' });
  } else {
    const y = [80, 110, 140][Math.floor(Math.random() * 3)];
    obstacles.push({ x: canvas.width, y, w: 46, h: 36, type: 'bird', wing: 0 });
  }
}

function update(dt) {
  if (!running) return;

  score += dt * 0.1;
  scoreEl.textContent = Math.floor(score);

  speed = Math.min(MAX_SPEED, speed + SPEED_RAMP * dt);

  dino.vy += GRAVITY;
  dino.y += dino.vy;
  if (dino.y >= 130) {
    dino.y = 130;
    dino.vy = 0;
    dino.grounded = true;
    dino.frame = (dino.frame + dt * 0.01) % 2;
  }

  groundX -= speed;
  if (groundX <= -40) groundX += 40;

  lastSpawn += dt;
  if (lastSpawn >= nextSpawn) {
    spawnObstacle();
    lastSpawn = 0;
    nextSpawn = randomSpawn();
  }

  for (const obs of obstacles) {
    obs.x -= speed;
    if (obs.type === 'bird') obs.wing = (obs.wing + dt * 0.015) % 2;
  }
  obstacles = obstacles.filter(o => o.x + o.w > 0);

  for (const obs of obstacles) {
    if (dino.x < obs.x + obs.w &&
        dino.x + dino.w > obs.x &&
        dino.y < obs.y + obs.h &&
        dino.y + dino.h > obs.y) {
      gameOver();
      return;
    }
  }
}

function gameOver() {
  running = false;
  if (score > hiScore) {
    hiScore = Math.floor(score);
    localStorage.setItem('dino-hi', hiScore);
    hiScoreEl.textContent = `HI ${hiScore}`;
  }
  finalScoreEl.textContent = `Score: ${Math.floor(score)}`;
  overlay.classList.remove('hidden');
}

function draw() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  ctx.strokeStyle = '#535353';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(groundX, 178);
  ctx.lineTo(groundX + canvas.width + 40, 178);
  ctx.stroke();
  for (let i = 0; i < 20; i++) {
    const x = groundX + i * 40;
    ctx.beginPath();
    ctx.moveTo(x, 178);
    ctx.lineTo(x + 20, 178);
    ctx.stroke();
  }

  ctx.fillStyle = '#535353';
  ctx.fillRect(dino.x, dino.y, dino.w, dino.h);
  ctx.fillStyle = '#fff';
  ctx.fillRect(dino.x + 30, dino.y + 8, 4, 4);

  for (const obs of obstacles) {
    ctx.fillStyle = '#535353';
    if (obs.type === 'cactus') {
      ctx.fillRect(obs.x, obs.y, obs.w, obs.h);
      ctx.fillRect(obs.x - 6, obs.y + obs.h * 0.3, 6, obs.h * 0.4);
      ctx.fillRect(obs.x + obs.w, obs.y + obs.h * 0.5, 6, obs.h * 0.3);
    } else {
      const wingUp = Math.floor(obs.wing) === 0;
      ctx.fillRect(obs.x, obs.y + (wingUp ? 0 : 8), obs.w, 12);
      ctx.fillRect(obs.x + 10, obs.y + (wingUp ? 4 : 12), 16, 8);
      ctx.fillRect(obs.x + 38, obs.y + (wingUp ? 0 : 8), 8, 12);
    }
  }
}

function loop(time) {
  const dt = time - lastTime;
  lastTime = time;
  update(dt);
  draw();
  requestAnimationFrame(loop);
}

function onJump() {
  if (!running) return;
  if (dino.grounded) {
    dino.vy = JUMP_FORCE;
    dino.grounded = false;
  }
}

window.addEventListener('keydown', e => {
  if (e.code === 'Space' || e.code === 'ArrowUp') { e.preventDefault(); onJump(); }
});
canvas.addEventListener('click', onJump);
canvas.addEventListener('touchstart', e => { e.preventDefault(); onJump(); });
restartBtn.addEventListener('click', reset);

reset();
requestAnimationFrame(loop);