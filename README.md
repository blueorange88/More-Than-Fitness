개인 트레이닝 일지 body { font-family: sans-serif; padding: 20px; } table { width: 100%; border-collapse: collapse; margin-top: 10px; } th, td { border: 1px solid #ccc; text-align: center; padding: 6px; } .signed { background-color: rgba(200, 200, 200, 0.5); pointer-events: none; } .sign-btn { padding: 3px 6px; font-size: 0.9em; } 

개인 트레이닝 일지

번호날짜시간운동 내용트레이너 사인고객 사인1SignSign2SignSign3SignSign function sign(button, role) { const cell = button.parentElement; cell.innerHTML = (role === 'trainer') ? '🖋️ Leon' : '🖋️ 고객'; cell.classList.add('signed'); } 
