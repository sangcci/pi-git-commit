# Commit Message Style

커밋 메시지는 diff의 의도를 짧고 자연스러운 한국어로 요약한다.

## 원칙

- conventional commit의 `type(scope):` 형식은 유지한다.
- type과 scope는 영어 토큰으로 둔다.
- subject는 한국어로 쓰되, 영어 표현을 단어 단위로 직역하지 않는다.
- `/commit`, `config`, `model`, `OpenAI`, 파일명처럼 그대로 쓰는 편이 명확한 표현은 번역하지 않는다.
- "문서 갱신", "프로젝트 파일 갱신"처럼 뭉뚱그린 표현보다 실제 변경 내용을 드러낸다.

## 예시

나쁜 예:

```text
chore(config): 모델 공급자 기본값 갱신
```

좋은 예:

```text
chore(config): /commit 기본 모델 설정 갱신
```

나쁜 예:

```text
docs(docs): 문서 갱신
```

좋은 예:

```text
docs(readme): promptFile 설정 방법 문서화
```
