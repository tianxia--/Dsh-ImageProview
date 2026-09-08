// Browser half of dsh-image-preview.
//
// Two seats, one visual language.
//
// 1. ATTACHMENTS. An image the agent reads (read_image, including through
//    run_code) arrives as a synthetic "user/message" whose source.kind is not
//    "user" (e.g. { kind: "plugin", plugin: "tools-code-mode" }). ui-chat
//    classifies every non-human user/message as a "context" node:
//
//        if (event.data.source.kind !== "user") return { kind: "context", ... }
//
//    and ContextInjectionRow has no image seat, so the attachment is dropped
//    from the Chat flow and only its text descriptor survives:
//
//        <path>/tmp/shot.png</path><type>image</type><content>...</content>
//
// 2. PATHS. read_image only admits PNG/JPEG/WebP/GIF, so a BMP, TIFF, HEIC,
//    SVG, ICO, PSD, TGA or Netpbm file never becomes an attachment at all --
//    it can only ever appear as a path in the transcript. Those paths are
//    resolved through this plugin's host routes (/image-preview/meta and
//    /image-preview/file), which validate, sniff and transcode.
//
// Both seats render through renderMessageImages, the seat ChatView passes to
// EVERY keyed node renderer, so thumbnails, load/retry states and the
// full-size lightbox are the official ui-attachment ones. Nothing here
// reimplements image UI, and no official component is overridden: conversation
// Definitions are not exclusive, so these rows are added beside the existing
// text rows rather than replacing them.
//
// Hand-written in the lazy-CJS client bundle protocol
// (window.__ModuleLoader__.load with a factory returning cordis-plugin
// exports): no build step, and no import of dsh client internals beyond react.
window.__ModuleLoader__.load({
  id: 'dsh-image-preview',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    var react = require('react')
    var jsxRuntime = require('react/jsx-runtime')
    var jsx = jsxRuntime.jsx
    var jsxs = jsxRuntime.jsxs

    /** Chat node kind == slot entry key: the keyed seat dispatches on node.kind. */
    var ATTACHMENT_KIND = 'agent-image'
    var PATH_KIND = 'agent-image-path'
    /** Conversation Definition kinds: unique across the whole client. */
    var ATTACHMENT_DEFINITION = 'agent-image-preview'
    var PATH_DEFINITION = 'agent-image-path-preview'

    /** Every extension the host route is willing to consider. */
    var EXTENSIONS = 'png|jpe?g|jpe|gif|webp|avif|bmp|dib|ico|cur|svgz?|tiff?|hei[cf]|hif|psd|tga|icb|vda|vst|jp2|j2k|jpf|jpx|pnm|pbm|pgm|ppm|pam|jxl|exr|dds'
    /** Markdown image syntax, both the plain and the <angle-bracket> form. */
    var MARKDOWN_ANGLE = /!\[[^\]]*\]\(\s*<([^>]+)>/g
    var MARKDOWN_PLAIN = new RegExp('!\\[[^\\]]*\\]\\(\\s*([^)\\s>]+\\.(?:' + EXTENSIONS + '))', 'gi')
    /** The read_image / tool descriptor form. */
    var DESCRIPTOR_PATH = /<path>([^<]+)<\/path>/g
    /**
     * Any path-shaped token ending in an image extension.
     *
     * Deliberately loose: "screenshot saved to /tmp/shot.png" should preview,
     * and the real filter is the host route, which only serves a path that
     * exists, sits under an allowed root, and sniffs as an actual image. Two
     * shapes are still excluded structurally: a bare word with no separator
     * (so "shot.png" in prose is not a path), and a token that continues past
     * the extension (so "src/app.png.ts" is a source file, not an image).
     */
    var PATH_TOKEN = new RegExp('(?:[A-Za-z]:)?(?:[\\\\/]|\\.{1,2}[\\\\/])[^\\s"\\x27\\x60<>|*?]*\\.(?:' + EXTENSIONS + ')(?=$|[\\s"\\x27\\x60)\\]}>,;:!?]|\\.(?:$|\\s))', 'gi')

    /** Candidate paths considered per message, and characters scanned per block. */
    var MAX_PATHS_PER_MESSAGE = 6
    var MAX_SCANNED_CHARS = 20000
    /** Bound on the meta-probe cache (one entry per path+cwd pair). */
    var META_CACHE_CAP = 500

    var metaCache = new Map()

    /** Gallery items in the shape ui-attachment expects: { attachment }. */
    function imagesOf(content) {
      if (!Array.isArray(content)) return []
      var images = []
      for (var index = 0; index < content.length; index += 1) {
        var block = content[index]
        if (block && block.type === 'image' && block.attachment !== undefined) images.push({ attachment: block.attachment })
      }
      return images
    }

    /** Concatenate the text blocks of a content array, bounded. */
    function textOf(content) {
      if (typeof content === 'string') return content.slice(0, MAX_SCANNED_CHARS)
      if (!Array.isArray(content)) return ''
      var parts = []
      for (var index = 0; index < content.length; index += 1) {
        var block = content[index]
        if (block && block.type === 'text' && typeof block.text === 'string') parts.push(block.text.slice(0, MAX_SCANNED_CHARS))
      }
      return parts.join('\n')
    }

    /** The <path> values of a tool descriptor, used for captions and probing. */
    function descriptorPaths(text) {
      var found = []
      DESCRIPTOR_PATH.lastIndex = 0
      var match = DESCRIPTOR_PATH.exec(text)
      while (match !== null) {
        found.push(match[1].trim())
        match = DESCRIPTOR_PATH.exec(text)
      }
      return found
    }

    /**
     * Collect image paths worth probing from one message's text. False
     * positives are cheap (the host answers "not an image" or "not found" and
     * the row renders nothing), but noise is still kept out by only accepting
     * markdown image syntax, tool descriptors, and lines that are a path and
     * nothing else.
     * @param text - concatenated message text.
     * @returns unique candidate paths, capped.
     */
    function candidatePaths(text) {
      if (typeof text !== 'string' || text === '') return []
      var found = []
      var push = (value) => {
        var trimmed = typeof value === 'string' ? value.trim() : ''
        if (trimmed === '' || trimmed.length > 1024) return
        if (!found.includes(trimmed)) found.push(trimmed)
      }
      var hasImageExtension = new RegExp('\\.(?:' + EXTENSIONS + ')$', 'i')
      var scan = (pattern, validate) => {
        pattern.lastIndex = 0
        var match = pattern.exec(text)
        while (match !== null && found.length < MAX_PATHS_PER_MESSAGE * 4) {
          if (validate === undefined || validate(match)) push(match[1] ?? match[0])
          match = pattern.exec(text)
        }
      }
      // The <angle> form may contain spaces, so it is matched on its own and
      // then required to actually name an image.
      scan(MARKDOWN_ANGLE, (match) => hasImageExtension.test(match[1].trim()))
      scan(MARKDOWN_PLAIN)
      var descriptors = descriptorPaths(text)
      for (var descriptorIndex = 0; descriptorIndex < descriptors.length; descriptorIndex += 1) push(descriptors[descriptorIndex])
      // A local path starts at a boundary. Requiring one rejects the tail of
      // a URL ("https://host/a.png" would otherwise be probed as
      // "s://host/a.png") without needing to understand URLs at all.
      var LEFT_BOUNDARY = /[\s"\x27\x60(\[{<>|,;=]/
      scan(PATH_TOKEN, (match) => {
        var before = match.index === 0 ? '' : text.charAt(match.index - 1)
        return before === '' || LEFT_BOUNDARY.test(before)
      })
      return found.slice(0, MAX_PATHS_PER_MESSAGE)
    }

    function basename(value) {
      var parts = String(value).split(/[\\/]/)
      return parts[parts.length - 1] || String(value)
    }

    /**
     * Ask the host whether one path is a displayable image, once per
     * path+cwd. A refusal is cached too: an unreadable path must not be
     * re-probed on every re-render.
     * @param path - candidate path from the transcript.
     * @param cwd - conversation working directory for relative paths.
     * @returns a gallery item, or null when the host will not serve it.
     */
    function probePath(path, cwd) {
      var suffix = typeof cwd === 'string' && cwd !== '' ? '&cwd=' + encodeURIComponent(cwd) : ''
      var metaUrl = '/image-preview/meta?path=' + encodeURIComponent(path) + suffix
      var pending = metaCache.get(metaUrl)
      if (pending === undefined) {
        if (metaCache.size >= META_CACHE_CAP) metaCache.clear()
        pending = fetch(metaUrl, { credentials: 'same-origin' })
          .then((response) => (response.ok ? response.json() : null))
          .then((meta) => (meta !== null && meta.ok === true ? meta : null))
          .catch(() => null)
        metaCache.set(metaUrl, pending)
      }
      return pending.then((meta) => {
        if (meta === null) return null
        var fileUrl = '/image-preview/file?path=' + encodeURIComponent(path) + suffix + '&v=' + encodeURIComponent(String(meta.version))
        var preview = { url: fileUrl, name: typeof meta.name === 'string' ? meta.name : basename(path) }
        if (typeof meta.width === 'number') preview.width = meta.width
        if (typeof meta.height === 'number') preview.height = meta.height
        return { preview: preview, meta: meta }
      })
    }

    var rowStyle = {
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'flex-start',
      gap: '4px',
      margin: '2px 0'
    }

    var captionStyle = {
      color: 'var(--dsw-alias-label-secondary)',
      fontSize: '12px',
      lineHeight: '18px',
      maxWidth: '100%',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap'
    }

    /**
     * One row: the official gallery plus a muted caption naming the files, so
     * the row still reads as "this image, from that path".
     */
    function imageRow(images, caption, title, seat) {
      return jsxs('div', {
        'data-dsh-image-preview': 'row',
        style: rowStyle,
        children: [
          seat({ images: images, align: 'start' }),
          caption === null ? null : jsx('span', { style: captionStyle, title: title, children: caption })
        ]
      })
    }

    /** Caption for attachment rows: the attachment names. */
    function attachmentCaption(state) {
      var names = []
      for (var index = 0; index < state.images.length; index += 1) {
        var attachment = state.images[index].attachment
        var name = attachment && typeof attachment.name === 'string' && attachment.name !== '' ? attachment.name : null
        if (name === null && state.paths[index] !== undefined) name = basename(state.paths[index])
        if (name !== null) names.push(name)
      }
      return names.length === 0 ? null : names.join(' \u00b7 ')
    }

    /** The already-attached case: zero extra network work. */
    function AgentImageRow(props) {
      var node = props.node
      var data = node && node.data ? node.data : null
      if (data === null || !Array.isArray(data.images) || data.images.length === 0) return null
      if (typeof props.renderMessageImages !== 'function') return null
      return imageRow(data.images, attachmentCaption(data), data.paths.join('\n'), props.renderMessageImages)
    }

    /**
     * The path case: probe the host, then render whatever it will serve.
     * Renders nothing until at least one path resolves, so a prose mention of
     * a missing file leaves no empty frame behind.
     */
    function AgentImagePathRow(props) {
      var node = props.node
      var data = node && node.data ? node.data : null
      var paths = data !== null && Array.isArray(data.paths) ? data.paths : []
      var cwd = typeof props.cwd === 'string' ? props.cwd : ''
      var cacheKey = paths.join('\u0000') + '\u0001' + cwd
      var state = react.useState([])
      var items = state[0]
      var setItems = state[1]
      react.useEffect(() => {
        var live = true
        if (paths.length === 0) {
          setItems([])
          return () => {}
        }
        Promise.all(paths.map((path) => probePath(path, cwd))).then((resolved) => {
          if (!live) return
          setItems(resolved.filter((entry) => entry !== null))
        })
        return () => {
          live = false
        }
      }, [cacheKey])
      if (items.length === 0) return null
      if (typeof props.renderMessageImages !== 'function') return null
      var names = items.map((item) => item.preview.name)
      var titles = items.map((item) => item.meta.path + (item.meta.transcoded === true ? '  (' + item.meta.format + ' \u2192 png)' : ''))
      return imageRow(items.map((item) => ({ preview: item.preview })), names.join(' \u00b7 '), titles.join('\n'), props.renderMessageImages)
    }

    /**
     * An agent-delivered image ATTACHMENT: a user/message that is not from the
     * human and carries at least one image block. Human pastes keep the native
     * path (kind "user" -> UserMessageNodeView), so nothing renders twice.
     */
    function attachmentState(event) {
      if (!event || event.type !== 'user/message') return null
      var data = event.data
      if (!data || !data.source || typeof data.source !== 'object') return null
      if (data.source.kind === 'user') return null
      var images = imagesOf(data.content)
      if (images.length === 0) return null
      return { seq: event.seq, time: event.time, images: images, paths: descriptorPaths(textOf(data.content)) }
    }

    /**
     * A message that only NAMES image files. Messages carrying attachments are
     * left to the attachment Definition above, so the two never overlap.
     */
    function pathOnlyState(event) {
      if (!event) return null
      if (event.type === 'user/message') {
        var data = event.data
        if (!data) return null
        if (imagesOf(data.content).length > 0) return null
        var userPaths = candidatePaths(textOf(data.content))
        return userPaths.length === 0 ? null : { seq: event.seq, time: event.time, paths: userPaths }
      }
      if (event.type === 'assistant/message') {
        var message = event.data && event.data.message
        if (!message) return null
        var assistantPaths = candidatePaths(textOf(message.content))
        return assistantPaths.length === 0 ? null : { seq: event.seq, time: event.time, paths: assistantPaths }
      }
      return null
    }

    /** Node identity for one matched event, independent of the other Definition. */
    function eventId(event) {
      var direct = event.data && event.data.id
      if (direct !== undefined && direct !== null) return String(direct)
      var nested = event.data && event.data.message && event.data.message.id
      if (nested !== undefined && nested !== null) return String(nested)
      return 'seq-' + String(event.seq)
    }

    /**
     * Build one Chat node from an assembled Definition context, mirroring
     * ui-chat's own chatNode(): the engine owns the key, the anchor sorts the
     * row, and the location keeps it inside its Turn.
     */
    function viewNode(context, kind) {
      var state = context.state
      if (state === undefined || state === null) return null
      var start = context.start
      var matches = context.matches
      var location = (start && start.location) || (matches && matches[0] && matches[0].location) || { kind: 'unresolved' }
      return {
        key: context.key,
        kind: kind,
        id: context.id,
        target: 'chat',
        anchorSeq: state.seq,
        location: location,
        visibility: 'visible',
        data: state
      }
    }

    var attachmentDefinition = {
      kind: ATTACHMENT_DEFINITION,
      target: 'chat',
      match: (event) => (attachmentState(event) === null ? null : { id: eventId(event), role: 'start' }),
      start: (_context, match) => attachmentState(match.event) ?? undefined,
      update: (context) => context.state,
      buildViewNode: (context) => viewNode(context, ATTACHMENT_KIND)
    }

    var pathDefinition = {
      kind: PATH_DEFINITION,
      target: 'chat',
      match: (event) => (pathOnlyState(event) === null ? null : { id: eventId(event), role: 'start' }),
      start: (_context, match) => pathOnlyState(match.event) ?? undefined,
      update: (context) => context.state,
      buildViewNode: (context) => viewNode(context, PATH_KIND)
    }

    /**
     * Pure helpers exposed for the offline test harness. Nothing in the app
     * reads this: the plugin's behavior is the two Definitions and the two
     * slot entries, and these are the same functions they are built from.
     */
    exports.__test = {
      candidatePaths: candidatePaths,
      attachmentState: attachmentState,
      pathOnlyState: pathOnlyState,
      probePath: probePath,
      viewNode: viewNode,
      components: { attachment: AgentImageRow, path: AgentImagePathRow }
    }

    exports.inject = ['slots', 'uiConversation']

    exports.apply = function apply(ctx) {
      var definitions = [attachmentDefinition, pathDefinition]
      for (var index = 0; index < definitions.length; index += 1) {
        try {
          // Same call shape ui-chat uses for its own message Definition: the
          // service routes registration through the caller's fiber, so plugin
          // unload withdraws the node kind again.
          ctx.uiConversation.events.register(definitions[index])
        } catch (error) {
          // A drift in the Definition contract must not take this plugin's
          // fiber (and with it the client boot) down.
          console.error('[dsh-image-preview] definition "' + definitions[index].kind + '" rejected: ' + (error && error.message ? error.message : error))
        }
      }

      var seats = [
        { key: ATTACHMENT_KIND, component: AgentImageRow },
        { key: PATH_KIND, component: AgentImagePathRow }
      ]
      for (var seatIndex = 0; seatIndex < seats.length; seatIndex += 1) {
        (function mount(seat) {
          ctx.slots.inject('conversation.chat.node', () =>
            ctx.slots.register(
              {
                name: 'conversation.chat.node',
                key: seat.key,
                locale: 'conversation'
              },
              seat.component
            )
          )
        })(seats[seatIndex])
      }
    }

    return module.exports
  }
})
