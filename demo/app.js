'use strict'

const panels = Array.from(document.querySelectorAll('.panel'))
const navs = Array.from(document.querySelectorAll('.nav'))
let current = 'idle'
let raf = 0

// Panels that genuinely animate. Everything else must be able to reach true zero damage —
// a permanently running rAF loop or CSS animation keeps Chromium painting forever, which keeps
// the terminal decoding and the GPU busy even on a "static" page.
const ANIMATED = new Set(['canvas', 'motion', 'cursor'])

function show(name) {
  current = name
  for (const p of panels) p.classList.toggle('active', p.dataset.panel === name)
  for (const n of navs) n.classList.toggle('active', n.dataset.panel === name)
  document.body.classList.toggle('quiet', !ANIMATED.has(name))
  cancelAnimationFrame(raf)
  if (name === 'canvas') startParticles()
  if (ANIMATED.has(name)) startMeter()
}

navs.forEach(n => n.addEventListener('click', () => show(n.dataset.panel)))
document.addEventListener('keydown', e => {
  const map = { 1: 'idle', 2: 'cursor', 3: 'scroll', 4: 'canvas', 5: 'motion', 6: 'form', 7: 'text' }
  if (map[e.key] && document.activeElement === document.body) show(map[e.key])
})

// ---- page-side fps ----
let frames = 0
let last = performance.now()
const fpsEl = document.getElementById('pagefps')
const budgetEl = document.getElementById('budget')
const barEl = document.getElementById('barfill')
let meterRaf = 0
function tick() {
  frames++
  const now = performance.now()
  if (now - last >= 500) {
    const fps = (frames * 1000) / (now - last)
    fpsEl.textContent = fps.toFixed(0)
    budgetEl.textContent = (1000 / Math.max(fps, 1)).toFixed(1) + ' ms'
    barEl.style.width = Math.min(100, (fps / 120) * 100).toFixed(0) + '%'
    frames = 0
    last = now
  }
  if (ANIMATED.has(current)) meterRaf = requestAnimationFrame(tick)
  else { fpsEl.textContent = 'idle'; budgetEl.textContent = '0 ms'; barEl.style.width = '0%' }
}
function startMeter() {
  cancelAnimationFrame(meterRaf)
  frames = 0
  last = performance.now()
  meterRaf = requestAnimationFrame(tick)
}

// ---- tiny updates ----
const clock = document.getElementById('clock')
const logline = document.getElementById('logline')
const typed = document.getElementById('typed')
const PHRASE = 'render --transport=shm --damage=tiles'
let typeIdx = 0
setInterval(() => {
  if (current !== 'cursor') return
  const d = new Date()
  clock.textContent =
    String(d.getHours()).padStart(2, '0') + ':' +
    String(d.getMinutes()).padStart(2, '0') + ':' +
    String(d.getSeconds()).padStart(2, '0') + '.' +
    String(d.getMilliseconds()).padStart(3, '0')
}, 16)
setInterval(() => {
  if (current !== 'cursor') return
  logline.textContent = `frame ${Math.floor(Math.random() * 90000)} · ${(Math.random() * 4 + 1).toFixed(2)}ms · ${Math.floor(Math.random() * 40 + 2)} tiles`
}, 220)
setInterval(() => {
  if (current !== 'cursor') return
  typeIdx = (typeIdx + 1) % (PHRASE.length + 12)
  typed.textContent = PHRASE.slice(0, Math.min(typeIdx, PHRASE.length))
}, 110)

// ---- scroll list ----
const list = document.getElementById('list')
const NAMES = ['ingest', 'tokenize', 'embed', 'shard', 'compact', 'verify', 'publish', 'reconcile']
let listHtml = ''
for (let i = 0; i < 2000; i++) {
  const state = i % 11 === 0 ? 'warn' : i % 3 === 0 ? 'ok' : ''
  const label = state === 'warn' ? 'retry' : state === 'ok' ? 'done' : 'queued'
  listHtml += `<div class="row"><span class="id">#${String(i).padStart(4, '0')}</span>` +
    `<span>${NAMES[i % NAMES.length]}-worker-${(i % 17) + 1}</span>` +
    `<span class="pill ${state}">${label}</span>` +
    `<span class="num">${(Math.sin(i) * 500 + 800).toFixed(1)}ms</span></div>`
}
list.innerHTML = listHtml

// ---- motion grid ----
const grid = document.getElementById('grid')
let gridHtml = ''
for (let i = 0; i < 96; i++) {
  const hue = 200 + (i % 12) * 8
  gridHtml += `<div class="tile" style="animation-delay:${(i % 17) * 0.13}s;background:hsl(${hue} 30% ${16 + (i % 5) * 3}%)"></div>`
}
grid.innerHTML = gridHtml

// ---- canvas particles ----
const canvas = document.getElementById('particles')
const ctx = canvas.getContext('2d', { alpha: false })
let parts = []
function startParticles() {
  const dpr = window.devicePixelRatio || 1
  canvas.width = canvas.clientWidth * dpr
  canvas.height = canvas.clientHeight * dpr
  if (parts.length === 0) {
    for (let i = 0; i < 420; i++) {
      parts.push({
        x: Math.random() * canvas.width,
        y: Math.random() * canvas.height,
        vx: (Math.random() - 0.5) * 2.4 * dpr,
        vy: (Math.random() - 0.5) * 2.4 * dpr,
        r: (Math.random() * 2.6 + 1.1) * dpr,
        h: 180 + Math.random() * 120,
      })
    }
  }
  const draw = () => {
    ctx.fillStyle = '#0e1014'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    for (const p of parts) {
      p.x += p.vx; p.y += p.vy
      if (p.x < 0 || p.x > canvas.width) p.vx *= -1
      if (p.y < 0 || p.y > canvas.height) p.vy *= -1
      ctx.beginPath()
      ctx.fillStyle = `hsl(${p.h} 70% 62%)`
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2)
      ctx.fill()
    }
    ctx.strokeStyle = 'rgba(120,150,255,0.10)'
    ctx.lineWidth = dpr
    for (let i = 0; i < parts.length; i += 7) {
      for (let j = i + 1; j < Math.min(i + 9, parts.length); j++) {
        const a = parts[i], b = parts[j]
        const d = Math.hypot(a.x - b.x, a.y - b.y)
        if (d < 150 * dpr) {
          ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke()
        }
      }
    }
    if (current === 'canvas') raf = requestAnimationFrame(draw)
  }
  draw()
}

// ---- form ----
let clicks = 0
const clicker = document.getElementById('clicker')
clicker.addEventListener('click', () => { clicks++; clicker.textContent = `Clicked ${clicks} times` })
const echo = document.getElementById('echo').querySelector('b')
document.getElementById('name').addEventListener('keydown', e => { echo.textContent = e.key })

window.__show = show
show('idle')
