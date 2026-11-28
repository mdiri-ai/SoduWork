export default {
  'OpenAI 兼容接口基础地址': 'OpenAI-compatible base URL',
  '当前地址缺少版本路径。若服务使用 /v1，请填写 {0}。': 'The URL has no version path. If the service uses /v1, enter {0}.',
  '请填写基础地址，去掉末尾的具体接口路径。例如 {0}。': 'Remove the operation path from the end of the URL. For example, enter {0}.',
  '请输入有效的 HTTP(S) 基础地址，省略账号、密码、查询参数和片段。例如 {0}。': 'Enter a valid HTTP(S) base URL without credentials, a query, or a fragment. For example, enter {0}.',
  '此网关直接在根地址提供接口，保留根地址': 'This gateway serves its API at the root. Keep the root URL.',
  '模型列表通过备用路径 /v1/models 读取。请按服务商文档核对对话接口的基础地址。': 'Model discovery used the fallback path /v1/models. Check the chat base URL in your provider’s documentation.',
  'Anthropic 服务根地址': 'Anthropic service root URL',
  '连接成功，本次读取到 {0} 个模型。': 'Connected. Retrieved {0} models. ',
  '示例：{0}。': 'Examples: {0}. ',
  '发消息前还需添加模型并确认额度。': 'Add a model and check its quota before sending messages.',
  '发现模型': 'Discover models',
  '从服务发现模型': 'Discover models from service',
  '列出「{0}」上游提供的模型标识，勾选后加入目录；已存在的不会重复出现。': 'Lists the model identifiers the upstream of “{0}” provides. Select the ones to add to the catalog; existing models are never duplicated.',
  '这个服务的模型都已经在目录里了。': 'Every model from this service is already in the catalog.',
  '全不选': 'Select none',
  '共 {0} 个': '{0} total',
  '发现的模型列表': 'Discovered models',
  '先勾选要添加的模型': 'Select the models to add first',
  '已添加 {0} 个模型': 'Added {0} model(s)',
  '添加了 {0} 个，{1} 个失败': 'Added {0}, {1} failed',
  '添加中…': 'Adding…',
  '添加选中的 {0} 个': 'Add the {0} selected',
}

export const ja = {
  'OpenAI 兼容接口基础地址': 'OpenAI 互換 API のベース URL',
  'Anthropic 服务根地址': 'Anthropic サービスのルート URL',
  '当前地址缺少版本路径。若服务使用 /v1，请填写 {0}。': 'URL にバージョンパスがありません。サービスが /v1 を使用する場合は {0} を入力してください。',
  '请填写基础地址，去掉末尾的具体接口路径。例如 {0}。': '末尾の操作パスを削除してベース URL を入力してください。例：{0}',
  '请输入有效的 HTTP(S) 基础地址，省略账号、密码、查询参数和片段。例如 {0}。': '認証情報、クエリ、フラグメントを含まない有効な HTTP(S) ベース URL を入力してください。例：{0}',
  '此网关直接在根地址提供接口，保留根地址': 'このゲートウェイはルートで API を提供するため、ルート URL を使用する',
  '模型列表通过备用路径 /v1/models 读取。请按服务商文档核对对话接口的基础地址。': 'モデル一覧は代替パス /v1/models から取得しました。プロバイダーのドキュメントでチャット用のベース URL を確認してください。',
}

export const ko = {
  'OpenAI 兼容接口基础地址': 'OpenAI 호환 API 기본 URL',
  'Anthropic 服务根地址': 'Anthropic 서비스 루트 URL',
  '当前地址缺少版本路径。若服务使用 /v1，请填写 {0}。': 'URL에 버전 경로가 없습니다. 서비스가 /v1을 사용한다면 {0}을 입력하세요.',
  '请填写基础地址，去掉末尾的具体接口路径。例如 {0}。': 'URL 끝에서 개별 작업 경로를 제거하고 기본 URL을 입력하세요. 예: {0}',
  '请输入有效的 HTTP(S) 基础地址，省略账号、密码、查询参数和片段。例如 {0}。': '인증 정보, 쿼리, 프래그먼트가 없는 올바른 HTTP(S) 기본 URL을 입력하세요. 예: {0}',
  '此网关直接在根地址提供接口，保留根地址': '이 게이트웨이는 루트에서 API를 제공하므로 루트 URL 사용',
  '模型列表通过备用路径 /v1/models 读取。请按服务商文档核对对话接口的基础地址。': '대체 경로 /v1/models에서 모델 목록을 가져왔습니다. 공급자 문서에서 채팅용 기본 URL을 확인하세요.',
}
