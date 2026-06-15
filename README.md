# pi-git-commit

Git commit extension입니다.
현재 변경사항을 살펴보고, AI를 이용해 커밋 단위 및 메세지를 제안하는 Git commit extension입니다.

English Version: [README.en.md](README.en.md)

## 기능

- 실제 Git 변경사항을 바탕으로 AI가 커밋 단위와 메시지 제안
- 커밋을 만들기 전 확인 절차
- 커밋 제목, 본문, footer 직접 edit 가능
- 추가 instruction 포함 메세지 재생성
- commitlint, `sem` 활용
- message 언어 설정
- staged 변경과 unstaged 변경 커밋 우선순위 선택
- AI model 사용 불가 시 huristic 버전 메세지 생성
- 실패 시 에러 출력 및 loop 종료
- Git 상태 수집, 제안 생성, 커밋 실행 단계 진행 UI 표시

## 동작 흐름

```text
/commit
   |
   v
Git 상태 수집
(status, diff, staged diff, log, optional sem)
   |
   v
커밋 범위 선택
(staged only / all working tree changes)
   |
   v
커밋 제안 생성
(AI first, heuristic fallback)
   |
   v
사용자 선택
(proceed / edit messages / regenerate / cancel)
   |
   v
git add + git commit 실행
   |
   v
성공: 커밋 요약 표시
실패: 에러 표시 후 중단
```

## 내부 구조

```text
index.ts
  register /commit
  runCommitWizard()
    loadConfig()
    collectGitState()
    chooseCommitMode()
    buildProposal()
      buildProposalWithModel()
      buildHeuristicProposal()
    editCommitMessages()
    executeCommits()
    classifyCommitFailure()
```

context는 `/commit` 명령 안에서만 유지됩니다. 명령이 끝나면 따로 context를 저장하지 않습니다.

## 사용법

### Installation

1. clone

```bash
git clone <repository-url> ~/Tools/pi-git-commit
```

원하는 위치에 clone해도 됩니다. 아래 예시는 `~/Tools/pi-git-commit`에 clone했다고 가정합니다.

2. register

```bash
pi -e ~/Tools/pi-git-commit/index.ts
```

`pi -e`로 extension 파일을 로드하면 pi 세션 안에서 `/commit` 명령을 사용할 수 있습니다. 다른 경로에 clone했다면 `index.ts` 경로만 맞춰주면 됩니다.

3. run

커밋을 만들 Git repository로 이동한 뒤 pi를 실행하고 명령을 입력합니다.

```text
/commit
```

명령을 실행하면 현재 repository의 Git 상태와 diff를 읽고, staged 변경과 unstaged 변경 상태에 맞춰 커밋 제안을 만듭니다.

## 기능 설명

### 진행 UI

명령 실행 중에는 editor 위에 `pi-git-commit` 진행 UI가 표시됩니다. Git 상태 수집, 커밋 범위 선택, AI 제안 생성, 사용자 확인, 실제 commit 실행 단계를 볼 수 있습니다.

커밋 실행 중에는 현재 실행 중인 커밋 번호, 메시지, stage 대상 파일 수, 완료된 커밋 요약이 표시됩니다. 실패하면 실패 단계와 reason을 표시한 뒤 에러를 출력하고 종료합니다.

### 제안 화면

제안 화면에서는 다음 선택지를 볼 수 있습니다.

- `Proceed as proposed` — 제안된 커밋을 그대로 실행합니다.
- `Edit commit messages` — 커밋 제목, 본문, footer를 직접 수정합니다.
- `Regenerate with instruction` — 추가 지시를 넣고 AI 제안을 다시 만듭니다.
- `Cancel` — 아무 커밋도 만들지 않고 종료합니다.

### staged / unstaged 변경이 섞여 있을 때

staged 변경과 unstaged 변경이 같이 있으면 먼저 범위를 고릅니다.

- `Use staged changes only`
- `Use all working tree changes`
- `Cancel`

`Use all working tree changes`를 고르면 제안된 커밋 단위마다 파일 전체를 stage합니다. hunk 단위 staging은 하지 않습니다.

### body와 footer 편집

커밋 메시지를 편집할 때 `body: |`, `footer: |` 줄은 지우지 말고 그대로 둡니다. 내용은 그 아래 줄에 들여쓰기해서 적으면 됩니다.

```text
Commit 1
message: feat(test): add dog module
body: |
  Add a new dog module used by the test repository.
  Keep animal behavior separate from math helpers.
footer: |
  Refs: TEST-123
```

위 내용은 실제 커밋 메시지에서 이렇게 들어갑니다.

```text
feat(test): add dog module

Add a new dog module used by the test repository.
Keep animal behavior separate from math helpers.

Refs: TEST-123
```

본문이나 footer가 필요 없으면 비워두면 됩니다.

```text
body: |
footer: |
```

## 설정

설정 파일은 선택 사항입니다.

프로젝트별 설정을 우선 적용합니다.

```text
<repo>/.pi/pi-git-commit.json
```

프로젝트별 설정 파일이 없으면 전역 설정을 사용합니다.

```text
~/.pi/agent/pi-git-commit.json
```

둘 다 없으면 기본값으로 동작합니다. 프로젝트별 설정과 전역 설정을 merge하지는 않으며, 프로젝트별 설정 파일이 있으면 전역 설정은 읽지 않습니다.

예시:

```json
{
  "message": {
    "language": "ko"
  },
  "lint": {
    "conventional": true,
    "types": ["feat", "fix", "docs", "test", "refactor", "chore"],
    "scopes": ["test"],
    "requireScope": true,
    "maxHeaderLength": 72,
    "maxSubjectLength": 60,
    "allowBody": true,
    "allowFooter": true
  },
  "commands": {
    "sem": "sem --json"
  }
}
```

### 메시지 언어

`message.language`는 커밋 제목, 본문, footer에 사용할 언어를 정합니다. 다만 conventional commit의 type과 scope는 영어 토큰을 그대로 둡니다.

예를 들어 `"language": "ko"`를 쓰면 이런 식의 메시지를 기대할 수 있습니다.

```text
feat(test): 수학 헬퍼 import 갱신
```

`"en"`, `"ko"`, 또는 `"Korean, concise"` 같은 커스텀 지시를 넣을 수 있습니다.

### lint 설정

`lint` 설정은 AI가 제안을 만들 때 참고하는 힌트입니다. 최종 판단은 실제 `git commit` 결과가 기준입니다. repository hook이나 commitlint가 더 엄격한 규칙을 적용할 수 있습니다.

## 실패 처리 정책

커밋은 여러 이유로 실패할 수 있습니다. 이에, `pi-git-commit`은 에러를 직접 handling하지 않고 종료해서 사용자가 직접 고칠 수 있게 합니다.

자동으로 재시도하거나, ignored file을 강제로 추가하거나, `.gitignore`를 수정하거나, hook을 바꾸지 않습니다. 이런 결정은 프로젝트마다 다르기 때문에 사용자가 직접 처리하는 편이 안전합니다. Git 상태를 정리한 뒤 `/commit`을 다시 실행하면 됩니다.

## bug report
