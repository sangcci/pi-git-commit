# Commit Message Style

커밋 메시지는 영어 표현을 한국어로 단어 단위 직역하지 않는다. diff, 파일 경로, 설정값의 변화를 보고 실제 변경 의도를 짧고 자연스럽게 요약한다.

## 원칙

- conventional commit의 type과 scope는 영어 토큰으로 유지한다.
- subject는 한국어로 쓰되, 개발자가 커밋 이력에서 바로 이해할 수 있게 구체적으로 쓴다.
- `/commit`, `config`, `model`, `provider`, `OpenAI`, 파일명, 명령어처럼 그대로 쓰는 편이 명확한 기술 식별자는 억지로 번역하지 않는다.
- "모델 공급자 기본값 갱신"처럼 명사만 이어 붙인 직역체를 피한다.
- "무엇을 바꿨는지"가 드러나게 쓴다.

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
docs(readme): 모델 설정과 실패 재시도 문서화
```
