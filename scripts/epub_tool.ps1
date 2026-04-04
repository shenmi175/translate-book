[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][string]$Mode,
  [string]$InputPath,
  [string]$TaskDir,
  [string]$JsonPath,
  [string]$TaskJsonPath,
  [string]$OutputPath,
  [string]$SourceFragmentBase64,
  [string]$TranslatedFragmentBase64,
  [string]$TranslatedSegmentsBase64
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
Add-Type -AssemblyName System.IO.Compression

function Ensure-Directory([string]$PathValue) {
  if (-not [string]::IsNullOrWhiteSpace($PathValue) -and -not (Test-Path -LiteralPath $PathValue)) {
    New-Item -ItemType Directory -Path $PathValue -Force | Out-Null
  }
}

function Remove-DirectoryIfExists([string]$PathValue) {
  if (Test-Path -LiteralPath $PathValue) {
    Remove-Item -LiteralPath $PathValue -Recurse -Force
  }
}

function Write-JsonFile([string]$PathValue, $Value) {
  Ensure-Directory ([System.IO.Path]::GetDirectoryName($PathValue))
  $json = $Value | ConvertTo-Json -Depth 100
  [System.IO.File]::WriteAllText($PathValue, $json, [System.Text.UTF8Encoding]::new($false))
}

function Read-JsonFile([string]$PathValue) {
  $text = [System.IO.File]::ReadAllText($PathValue, [System.Text.Encoding]::UTF8)
  return $text | ConvertFrom-Json
}

function Get-XmlDocumentFromFile([string]$PathValue) {
  $doc = New-Object System.Xml.XmlDocument
  $doc.PreserveWhitespace = $true
  $content = [System.IO.File]::ReadAllText($PathValue, [System.Text.Encoding]::UTF8)
  $doc.LoadXml($content)
  return $doc
}

function Get-XmlDocumentFromString([string]$XmlText) {
  $doc = New-Object System.Xml.XmlDocument
  $doc.PreserveWhitespace = $true
  $doc.LoadXml($XmlText)
  return $doc
}

function Save-XmlDocument([System.Xml.XmlDocument]$Document, [string]$PathValue) {
  $settings = New-Object System.Xml.XmlWriterSettings
  $settings.Encoding = [System.Text.UTF8Encoding]::new($false)
  $settings.Indent = $false
  $settings.NewLineHandling = [System.Xml.NewLineHandling]::None
  $writer = [System.Xml.XmlWriter]::Create($PathValue, $settings)
  $Document.Save($writer)
  $writer.Dispose()
}

function Get-ElementChildren([System.Xml.XmlNode]$Node) {
  $result = New-Object System.Collections.Generic.List[System.Xml.XmlElement]
  foreach ($child in $Node.ChildNodes) {
    if ($child.NodeType -eq [System.Xml.XmlNodeType]::Element) {
      [void]$result.Add([System.Xml.XmlElement]$child)
    }
  }
  return $result.ToArray()
}

function Get-LogicalChildren([System.Xml.XmlNode]$Node) {
  $result = New-Object System.Collections.Generic.List[System.Xml.XmlNode]
  foreach ($child in $Node.ChildNodes) {
    if ($child.NodeType -eq [System.Xml.XmlNodeType]::Element) {
      [void]$result.Add($child)
      continue
    }
    if (($child.NodeType -eq [System.Xml.XmlNodeType]::Text -or $child.NodeType -eq [System.Xml.XmlNodeType]::CDATA) -and -not [string]::IsNullOrWhiteSpace($child.Value)) {
      [void]$result.Add($child)
    }
  }
  return $result.ToArray()
}

function Normalize-Whitespace([string]$Value) {
  if ([string]::IsNullOrWhiteSpace($Value)) {
    return ''
  }
  return ([System.Text.RegularExpressions.Regex]::Replace($Value, '\s+', ' ')).Trim()
}

function Get-CollectionCount($Value) {
  if ($null -eq $Value) {
    return 0
  }
  if ($Value -is [string]) {
    return 1
  }
  if ($Value -is [System.Array]) {
    return $Value.Length
  }
  if ($Value -is [System.Collections.ICollection]) {
    return $Value.Count
  }
  if ($Value -is [System.Collections.IEnumerable]) {
    $count = 0
    foreach ($item in $Value) {
      $count += 1
    }
    return $count
  }
  return 1
}

function Get-SegmentPlaceholder([int]$Index) {
  return ('__MTS_SEG_{0}__' -f $Index.ToString('0000'))
}

function Get-ElementIndex([System.Xml.XmlElement]$Element) {
  $index = 0
  if ($null -eq $Element.ParentNode) {
    return 1
  }
  foreach ($sibling in $Element.ParentNode.ChildNodes) {
    if ($sibling.NodeType -ne [System.Xml.XmlNodeType]::Element) {
      continue
    }
    if ($sibling.LocalName -eq $Element.LocalName) {
      $index += 1
    }
    if ([object]::ReferenceEquals($sibling, $Element)) {
      return $index
    }
  }
  return [Math]::Max(1, $index)
}

function Get-NodePath([System.Xml.XmlNode]$Node) {
  if ($Node.NodeType -ne [System.Xml.XmlNodeType]::Element) {
    throw 'Only element nodes can be addressed in the EPUB block map.'
  }
  $parts = New-Object System.Collections.Generic.List[string]
  $cursor = [System.Xml.XmlElement]$Node
  while ($null -ne $cursor -and $cursor.NodeType -eq [System.Xml.XmlNodeType]::Element) {
    $parts.Insert(0, ('{0}[{1}]' -f $cursor.LocalName, (Get-ElementIndex $cursor)))
    if ($null -eq $cursor.ParentNode -or $cursor.ParentNode.NodeType -ne [System.Xml.XmlNodeType]::Element) {
      break
    }
    $cursor = [System.Xml.XmlElement]$cursor.ParentNode
  }
  return '/' + ($parts -join '/')
}

function Find-NodeByPath([System.Xml.XmlDocument]$Document, [string]$NodePath) {
  $segments = $NodePath.Trim('/').Split('/', [System.StringSplitOptions]::RemoveEmptyEntries)
  $current = $Document.DocumentElement
  foreach ($segment in $segments) {
    if ($segment -notmatch '^(?<name>[^\[]+)\[(?<index>\d+)\]$') {
      throw "Invalid node path segment: $segment"
    }
    $name = $Matches['name']
    $index = [int]$Matches['index']
    if ($null -eq $current) {
      return $null
    }
    if ($current.LocalName -eq $name -and $index -eq 1 -and $segment -eq $segments[0]) {
      continue
    }
    $count = 0
    $match = $null
    foreach ($child in $current.ChildNodes) {
      if ($child.NodeType -ne [System.Xml.XmlNodeType]::Element) { continue }
      if ($child.LocalName -ne $name) { continue }
      $count += 1
      if ($count -eq $index) {
        $match = [System.Xml.XmlElement]$child
        break
      }
    }
    $current = $match
  }
  return $current
}

function Get-StructureSignature([System.Xml.XmlNode]$Node) {
  if ($Node.NodeType -eq [System.Xml.XmlNodeType]::Text -or $Node.NodeType -eq [System.Xml.XmlNodeType]::CDATA) {
    return '#text'
  }
  if ($Node.NodeType -ne [System.Xml.XmlNodeType]::Element) {
    return ''
  }
  $attributeNames = @()
  if ($null -ne $Node.Attributes) {
    foreach ($attribute in $Node.Attributes) {
      if ($attribute.Prefix -eq 'xmlns' -or $attribute.Name -eq 'xmlns') { continue }
      $attributeNames += $attribute.Name
    }
  }
  $attributePart = ($attributeNames | Sort-Object) -join ','
  $children = New-Object System.Collections.Generic.List[string]
  foreach ($child in (Get-LogicalChildren $Node)) {
    [void]$children.Add((Get-StructureSignature $child))
  }
  return ('<{0}|{1}>{2}</{0}>' -f $Node.LocalName, $attributePart, ($children -join ''))
}

function Get-VisibleText([System.Xml.XmlNode]$Node) {
  $parts = New-Object System.Collections.Generic.List[string]
  function Visit([System.Xml.XmlNode]$InnerNode) {
    if ($InnerNode.NodeType -eq [System.Xml.XmlNodeType]::Text -or $InnerNode.NodeType -eq [System.Xml.XmlNodeType]::CDATA) {
      $text = Normalize-Whitespace $InnerNode.Value
      if ($text) { [void]$parts.Add($text) }
      return
    }
    if ($InnerNode.NodeType -ne [System.Xml.XmlNodeType]::Element) {
      return
    }
    $name = $InnerNode.LocalName.ToLowerInvariant()
    if ($name -in @('script', 'style')) {
      return
    }
    if ($name -eq 'img' -and $InnerNode.Attributes['alt']) {
      $altText = Normalize-Whitespace $InnerNode.Attributes['alt'].Value
      if ($altText) { [void]$parts.Add($altText) }
    }
    foreach ($child in $InnerNode.ChildNodes) {
      Visit $child
    }
  }
  Visit $Node
  return ($parts -join ' ').Trim()
}

function Get-TranslatableSegmentDescriptors([System.Xml.XmlElement]$RootElement) {
  $segments = New-Object System.Collections.Generic.List[object]
  $segmentOrdinal = 0

  function Visit-SegmentDescriptorNode([System.Xml.XmlNode]$Node, [string]$CurrentPath) {
    if ($Node.NodeType -ne [System.Xml.XmlNodeType]::Element) {
      return
    }

    $element = [System.Xml.XmlElement]$Node
    if ($element.Attributes["title"]) {
      $titleText = Normalize-Whitespace $element.Attributes["title"].Value
      if ($titleText) {
        $segmentOrdinal += 1
        [void]$segments.Add([ordered]@{
          index = $segmentOrdinal
          token = Get-SegmentPlaceholder $segmentOrdinal
          kind = "attribute"
          path = $CurrentPath + "/@title"
          attributeName = "title"
          sourceText = $titleText
        })
      }
    }
    if ($element.LocalName.ToLowerInvariant() -eq "img" -and $element.Attributes["alt"]) {
      $altText = Normalize-Whitespace $element.Attributes["alt"].Value
      if ($altText) {
        $segmentOrdinal += 1
        [void]$segments.Add([ordered]@{
          index = $segmentOrdinal
          token = Get-SegmentPlaceholder $segmentOrdinal
          kind = "attribute"
          path = $CurrentPath + "/@alt"
          attributeName = "alt"
          sourceText = $altText
        })
      }
    }

    $textIndex = 0
    $childElementCounts = @{}
    foreach ($child in $element.ChildNodes) {
      if (($child.NodeType -eq [System.Xml.XmlNodeType]::Text -or $child.NodeType -eq [System.Xml.XmlNodeType]::CDATA) -and -not [string]::IsNullOrWhiteSpace($child.Value)) {
        $textIndex += 1
        $segmentText = Normalize-Whitespace $child.Value
        if ($segmentText) {
          $segmentOrdinal += 1
          [void]$segments.Add([ordered]@{
            index = $segmentOrdinal
            token = Get-SegmentPlaceholder $segmentOrdinal
            kind = "text"
            path = $CurrentPath + "/#text[" + $textIndex + "]"
            attributeName = ""
            sourceText = $segmentText
          })
        }
        continue
      }
      if ($child.NodeType -ne [System.Xml.XmlNodeType]::Element) {
        continue
      }
      $childName = $child.LocalName
      if (-not $childElementCounts.ContainsKey($childName)) {
        $childElementCounts[$childName] = 0
      }
      $childElementCounts[$childName] += 1
      $childPath = $CurrentPath + "/" + $childName + "[" + $childElementCounts[$childName] + "]"
      Visit-SegmentDescriptorNode $child $childPath
    }
  }

  Visit-SegmentDescriptorNode $RootElement ("/" + $RootElement.LocalName + "[1]")
  return $segments.ToArray()
}

function Get-TranslatableSegmentTargets([System.Xml.XmlElement]$RootElement) {
  $targets = New-Object System.Collections.Generic.List[object]

  function Visit-SegmentTargetNode([System.Xml.XmlNode]$Node) {
    if ($Node.NodeType -ne [System.Xml.XmlNodeType]::Element) {
      return
    }

    $element = [System.Xml.XmlElement]$Node
    if ($element.Attributes["title"]) {
      $titleText = Normalize-Whitespace $element.Attributes["title"].Value
      if ($titleText) {
        [void]$targets.Add([ordered]@{
          kind = "attribute"
          element = $element
          attributeName = "title"
          node = $null
        })
      }
    }
    if ($element.LocalName.ToLowerInvariant() -eq "img" -and $element.Attributes["alt"]) {
      $altText = Normalize-Whitespace $element.Attributes["alt"].Value
      if ($altText) {
        [void]$targets.Add([ordered]@{
          kind = "attribute"
          element = $element
          attributeName = "alt"
          node = $null
        })
      }
    }

    foreach ($child in $element.ChildNodes) {
      if (($child.NodeType -eq [System.Xml.XmlNodeType]::Text -or $child.NodeType -eq [System.Xml.XmlNodeType]::CDATA) -and -not [string]::IsNullOrWhiteSpace($child.Value)) {
        [void]$targets.Add([ordered]@{
          kind = "text"
          element = $null
          attributeName = ""
          node = $child
        })
        continue
      }
      if ($child.NodeType -eq [System.Xml.XmlNodeType]::Element) {
        Visit-SegmentTargetNode $child
      }
    }
  }

  Visit-SegmentTargetNode $RootElement
  return $targets.ToArray()
}

function Get-SegmentTemplates([System.Xml.XmlElement]$Element, [string]$BlockType) {
  $templateDoc = Get-XmlDocumentFromString $Element.OuterXml
  $targets = @(Get-TranslatableSegmentTargets $templateDoc.DocumentElement)
  for ($index = 0; $index -lt @($targets).Count; $index += 1) {
    $token = Get-SegmentPlaceholder ($index + 1)
    $target = $targets[$index]
    if ($target.kind -eq 'text') {
      $target.node.Value = $token
      continue
    }
    if ($target.kind -eq 'attribute') {
      $target.element.SetAttribute($target.attributeName, $token)
    }
  }

  return [ordered]@{
    segmentTemplate = $templateDoc.DocumentElement.OuterXml
    previewTemplate = Get-PreviewForBlock $templateDoc.DocumentElement $BlockType
  }
}

function Apply-TranslatedSegments([System.Xml.XmlElement]$RootElement, $TranslatedSegments) {
  $targets = @(Get-TranslatableSegmentTargets $RootElement)
  $translations = @($TranslatedSegments)
  $targetCount = Get-CollectionCount $targets
  $translationCount = Get-CollectionCount $translations
  if ($targetCount -ne $translationCount) {
    throw "Translated segment count does not match the source fragment."
  }

  for ($index = 0; $index -lt $targetCount; $index += 1) {
    $target = $targets[$index]
    $translatedValue = [string]$translations[$index]
    if ($target.kind -eq "text") {
      $target.node.Value = $translatedValue
      continue
    }
    if ($target.kind -eq "attribute") {
      $target.element.SetAttribute($target.attributeName, $translatedValue)
    }
  }
}

function Get-TablePreview([System.Xml.XmlElement]$Element) {
  $lines = New-Object System.Collections.Generic.List[string]
  $rows = $Element.SelectNodes('.//*[local-name()="tr"]')
  foreach ($row in $rows) {
    $cells = New-Object System.Collections.Generic.List[string]
    foreach ($cell in $row.ChildNodes) {
      if ($cell.NodeType -ne [System.Xml.XmlNodeType]::Element) { continue }
      if ($cell.LocalName -notin @('th', 'td')) { continue }
      [void]$cells.Add((Get-VisibleText $cell))
    }
    if (@($cells).Count -gt 0) {
      [void]$lines.Add('| ' + ($cells -join ' | ') + ' |')
    }
  }
  return ($lines -join "`n")
}

function Get-BlockType([System.Xml.XmlElement]$Element) {
  $name = $Element.LocalName.ToLowerInvariant()
  switch ($name) {
    { $_ -in @('h1', 'h2', 'h3', 'h4', 'h5', 'h6') } { return 'heading' }
    'p' { return 'paragraph' }
    'li' { return 'list_item' }
    'blockquote' { return 'blockquote' }
    'table' { return 'table' }
    'pre' { return 'fenced_code' }
    'code' { return 'fenced_code' }
    'img' { return 'image' }
    'figure' { return 'image' }
    'hr' { return 'thematic_break' }
    default { return $null }
  }
}

function Get-PreviewForBlock([System.Xml.XmlElement]$Element, [string]$BlockType) {
  $visibleText = Get-VisibleText $Element
  switch ($BlockType) {
    'heading' {
      $level = 1
      if ($Element.LocalName.Length -gt 1) {
        $level = [int]$Element.LocalName.Substring(1)
      }
      return ('{0} {1}' -f ('#' * $level), $visibleText).Trim()
    }
    'paragraph' { return $visibleText }
    'list_item' { return ('- ' + $visibleText).Trim() }
    'blockquote' { return ('> ' + $visibleText).Trim() }
    'table' { return Get-TablePreview $Element }
    'fenced_code' { return ('```' + "`n" + $Element.InnerText.Trim() + "`n" + '```') }
    'image' {
      $imageNode = $Element
      if ($Element.LocalName.ToLowerInvariant() -eq 'figure') {
        $candidate = $Element.SelectSingleNode('.//*[local-name()="img"]')
        if ($null -ne $candidate) {
          $imageNode = [System.Xml.XmlElement]$candidate
        }
      }
      $altText = if ($imageNode.Attributes['alt']) { $imageNode.Attributes['alt'].Value } else { '' }
      $srcText = if ($imageNode.Attributes['src']) { $imageNode.Attributes['src'].Value } else { '' }
      $captionNode = $Element.SelectSingleNode('.//*[local-name()="figcaption"]')
      $captionText = if ($null -ne $captionNode) { Get-VisibleText $captionNode } else { '' }
      $imageLine = ('![{0}]({1})' -f $altText, $srcText)
      if ($captionText) {
        return ($imageLine + "`n" + $captionText).Trim()
      }
      return $imageLine.Trim()
    }
    'thematic_break' { return '---' }
    default { return $visibleText }
  }
}

function New-CounterId([hashtable]$Counters, [string]$Prefix) {
  if (-not $Counters.ContainsKey($Prefix)) {
    $Counters[$Prefix] = 0
  }
  $Counters[$Prefix] += 1
  return '{0}-{1}' -f $Prefix, $Counters[$Prefix].ToString('000')
}

function Get-BlockPrefix([string]$BlockType) {
  switch ($BlockType) {
    'heading' { return 'h' }
    'paragraph' { return 'p' }
    'list_item' { return 'li' }
    'blockquote' { return 'bq' }
    'table' { return 'tbl' }
    'image' { return 'img' }
    'fenced_code' { return 'code' }
    'thematic_break' { return 'hr' }
    default { return 'blk' }
  }
}

function Should-Translate([string]$BlockType) {
  return $BlockType -in @('heading', 'paragraph', 'list_item', 'blockquote', 'table', 'image')
}

function Get-SkipReason([string]$BlockType) {
  switch ($BlockType) {
    'fenced_code' { return 'Code-like XHTML blocks are skipped by default.' }
    'thematic_break' { return 'Thematic breaks do not need translation.' }
    default { return '' }
  }
}

function Get-TokenEstimate([string]$Text) {
  return [Math]::Max(1, [Math]::Ceiling(($Text.Length) / 4))
}

$script:CurrentHeadingPath = New-Object System.Collections.ArrayList
$script:CurrentOrder = 0

function Set-CurrentHeading([int]$Level, [string]$Label) {
  while (@($script:CurrentHeadingPath).Count -ge $Level) {
    $script:CurrentHeadingPath.RemoveAt(@($script:CurrentHeadingPath).Count - 1)
  }
  [void]$script:CurrentHeadingPath.Add($Label)
}

function New-BlockObject([System.Xml.XmlElement]$Element, [string]$BlockType, [string]$ChapterPath, [int]$ChapterIndex, [hashtable]$Counters) {
  $preview = Get-PreviewForBlock $Element $BlockType
  $sourceText = Get-VisibleText $Element
  $blockId = New-CounterId $Counters (Get-BlockPrefix $BlockType)
  $nodePath = Get-NodePath $Element
  $shouldTranslate = Should-Translate $BlockType
  $segments = if ($shouldTranslate) { @(Get-TranslatableSegmentDescriptors $Element) } else { @() }
  $segmentCount = Get-CollectionCount $segments
  $templates = if ($shouldTranslate -and $segmentCount -gt 0) { Get-SegmentTemplates $Element $BlockType } else { $null }
  $textOnlyFragment = $shouldTranslate -and (@((Get-ElementChildren $Element)).Count -eq 0) -and ($segmentCount -eq 1)
  $segmentMappedFragment = $shouldTranslate -and ($segmentCount -gt 0)
  $order = $script:CurrentOrder
  $script:CurrentOrder += 1
  return [ordered]@{
    id = $blockId
    type = $BlockType
    order = $order
    headingPath = @($script:CurrentHeadingPath)
    sourceMarkdown = $preview
    translatedMarkdown = if ($shouldTranslate) { '' } else { $preview }
    status = if ($shouldTranslate) { 'idle' } else { 'skipped' }
    shouldTranslate = $shouldTranslate
    skipped = (-not $shouldTranslate)
    skipReason = if ($shouldTranslate) { '' } else { (Get-SkipReason $BlockType) }
    locked = $false
    annotations = @()
    comments = @()
    retryCount = 0
    failureCount = 0
    tokenEstimate = Get-TokenEstimate $preview
    separatorAfter = "`n`n"
    errorMessage = ''
    lastTranslatedAt = ''
    lastEditedAt = ''
    sourceRange = [ordered]@{
      startLine = 0
      endLine = 0
      startOffset = 0
      endOffset = 0
      documentPath = $ChapterPath
      nodePath = $nodePath
    }
    translationUnit = [ordered]@{
      mode = 'epub_xhtml_fragment'
      chapterPath = $ChapterPath
      chapterIndex = $ChapterIndex
      nodePath = $nodePath
      sourceFragment = $Element.OuterXml
      sourceText = $sourceText
      textOnly = $textOnlyFragment
      segmentMapped = $segmentMappedFragment
      segments = $segments
      segmentTemplate = if ($null -ne $templates) { $templates.segmentTemplate } else { '' }
      previewTemplate = if ($null -ne $templates) { $templates.previewTemplate } else { '' }
      translatedFragment = ''
      structureSignature = Get-StructureSignature $Element
      rootTag = $Element.LocalName
    }
  }
}

function Visit-BodyElement([System.Xml.XmlElement]$Element, [string]$ChapterPath, [int]$ChapterIndex, [System.Collections.Generic.List[object]]$Blocks, [hashtable]$Counters) {
  $blockType = Get-BlockType $Element
  if ($null -ne $blockType) {
    if ($blockType -eq 'heading') {
      $level = [int]$Element.LocalName.Substring(1)
      Set-CurrentHeading $level (Get-VisibleText $Element)
    }
    [void]$Blocks.Add((New-BlockObject $Element $blockType $ChapterPath $ChapterIndex $Counters))
    return
  }
  foreach ($child in (Get-ElementChildren $Element)) {
    Visit-BodyElement $child $ChapterPath $ChapterIndex $Blocks $Counters
  }
}

function Resolve-Href([string]$BaseDirectory, [string]$Href) {
  $cleanHref = ($Href -split '#')[0]
  $cleanHref = ($cleanHref -split '\?')[0]
  $combined = [System.IO.Path]::Combine($BaseDirectory, ($cleanHref -replace '/', [System.IO.Path]::DirectorySeparatorChar))
  return [System.IO.Path]::GetFullPath($combined)
}

function Get-RelativePath([string]$BasePath, [string]$TargetPath) {
  $baseItem = Get-Item -LiteralPath $BasePath
  $targetItem = Get-Item -LiteralPath $TargetPath
  $baseFullPath = $baseItem.FullName
  if ($baseItem.PSIsContainer -and -not $baseFullPath.EndsWith([System.IO.Path]::DirectorySeparatorChar)) {
    $baseFullPath += [System.IO.Path]::DirectorySeparatorChar
  }
  $baseUri = New-Object System.Uri($baseFullPath)
  $targetUri = New-Object System.Uri($targetItem.FullName)
  return [System.Uri]::UnescapeDataString($baseUri.MakeRelativeUri($targetUri).ToString()).Replace('\', '/')
}

function Get-PackageState([string]$ExtractedRoot) {
  $containerPath = Join-Path $ExtractedRoot 'META-INF/container.xml'
  if (-not (Test-Path -LiteralPath $containerPath)) {
    throw 'EPUB is missing META-INF/container.xml.'
  }
  $containerDoc = Get-XmlDocumentFromFile $containerPath
  $rootfileNode = $containerDoc.SelectSingleNode('//*[local-name()="rootfile"]')
  if ($null -eq $rootfileNode) {
    throw 'EPUB container.xml does not define a rootfile.'
  }
  $fullPathValue = $rootfileNode.Attributes['full-path'].Value
  if ([string]::IsNullOrWhiteSpace($fullPathValue)) {
    throw 'EPUB rootfile full-path is empty.'
  }
  $packagePath = Join-Path $ExtractedRoot ($fullPathValue -replace '/', [System.IO.Path]::DirectorySeparatorChar)
  if (-not (Test-Path -LiteralPath $packagePath)) {
    throw "EPUB package document was not found: $fullPathValue"
  }
  $packageDoc = Get-XmlDocumentFromFile $packagePath
  $manifestItems = @{}
  foreach ($item in $packageDoc.SelectNodes('//*[local-name()="manifest"]/*[local-name()="item"]')) {
    $itemId = $item.Attributes['id'].Value
    $manifestItems[$itemId] = [ordered]@{
      href = $item.Attributes['href'].Value
      mediaType = $item.Attributes['media-type'].Value
      properties = if ($item.Attributes['properties']) { $item.Attributes['properties'].Value } else { '' }
    }
  }
  $spine = New-Object System.Collections.Generic.List[object]
  foreach ($itemRef in $packageDoc.SelectNodes('//*[local-name()="spine"]/*[local-name()="itemref"]')) {
    $idref = $itemRef.Attributes['idref'].Value
    if (-not $manifestItems.ContainsKey($idref)) {
      throw "EPUB spine itemref $idref is missing from the manifest."
    }
    [void]$spine.Add([ordered]@{
      idref = $idref
      href = $manifestItems[$idref].href
      mediaType = $manifestItems[$idref].mediaType
      absolutePath = Resolve-Href ([System.IO.Path]::GetDirectoryName($packagePath)) $manifestItems[$idref].href
    })
  }
  $titleNode = $packageDoc.SelectSingleNode('//*[local-name()="metadata"]/*[local-name()="title"]')
  $languageNode = $packageDoc.SelectSingleNode('//*[local-name()="metadata"]/*[local-name()="language"]')
  return [ordered]@{
    packagePath = $packagePath
    packageRelativePath = Get-RelativePath $ExtractedRoot $packagePath
    packageDirectory = [System.IO.Path]::GetDirectoryName($packagePath)
    manifest = $manifestItems
    spine = $spine
    title = if ($null -ne $titleNode) { $titleNode.InnerText } else { '' }
    language = if ($null -ne $languageNode) { $languageNode.InnerText } else { '' }
  }
}

function Validate-ExtractedEpub([string]$ExtractedRoot) {
  $mimetypePath = Join-Path $ExtractedRoot 'mimetype'
  if (-not (Test-Path -LiteralPath $mimetypePath)) {
    throw 'EPUB is missing the mimetype file.'
  }
  $mimetypeValue = [System.IO.File]::ReadAllText($mimetypePath, [System.Text.Encoding]::ASCII).Trim()
  if ($mimetypeValue -ne 'application/epub+zip') {
    throw 'EPUB mimetype file is invalid.'
  }
  $state = Get-PackageState $ExtractedRoot
  foreach ($spineItem in $state.spine) {
    if (-not (Test-Path -LiteralPath $spineItem.absolutePath)) {
      throw "EPUB spine content is missing: $($spineItem.href)"
    }
    if ($spineItem.mediaType -eq 'application/xhtml+xml') {
      [void](Get-XmlDocumentFromFile $spineItem.absolutePath)
    }
  }
  return $state
}

function Create-EpubZip([string]$SourceDirectory, [string]$DestinationPath) {
  if (Test-Path -LiteralPath $DestinationPath) {
    Remove-Item -LiteralPath $DestinationPath -Force
  }
  $fileStream = [System.IO.File]::Open($DestinationPath, [System.IO.FileMode]::Create)
  try {
    $archive = [System.IO.Compression.ZipArchive]::new($fileStream, [System.IO.Compression.ZipArchiveMode]::Create, $false)
    try {
      $mimetypeEntry = $archive.CreateEntry('mimetype', [System.IO.Compression.CompressionLevel]::NoCompression)
      $writer = New-Object System.IO.StreamWriter($mimetypeEntry.Open(), [System.Text.UTF8Encoding]::new($false))
      $writer.Write('application/epub+zip')
      $writer.Dispose()

      $files = Get-ChildItem -LiteralPath $SourceDirectory -Recurse -File | Sort-Object FullName
      foreach ($file in $files) {
        $relativePath = Get-RelativePath $SourceDirectory $file.FullName
        if ($relativePath -eq 'mimetype') { continue }
        $entry = $archive.CreateEntry($relativePath, [System.IO.Compression.CompressionLevel]::Optimal)
        $entryStream = $entry.Open()
        $inputStream = [System.IO.File]::OpenRead($file.FullName)
        $inputStream.CopyTo($entryStream)
        $inputStream.Dispose()
        $entryStream.Dispose()
      }
    } finally {
      $archive.Dispose()
    }
  } finally {
    $fileStream.Dispose()
  }
}

function Merge-TranslatedElement([System.Xml.XmlElement]$SourceElement, [System.Xml.XmlElement]$TranslatedElement) {
  if ($SourceElement.LocalName -ne $TranslatedElement.LocalName) {
    throw 'Translated fragment root does not match the source fragment root.'
  }
  if ((Get-StructureSignature $SourceElement) -ne (Get-StructureSignature $TranslatedElement)) {
    throw 'Translated fragment structure does not match the source fragment.'
  }

  foreach ($attributeName in @('alt', 'title')) {
    if ($TranslatedElement.Attributes[$attributeName]) {
      if ($SourceElement.Attributes[$attributeName]) {
        $SourceElement.Attributes[$attributeName].Value = $TranslatedElement.Attributes[$attributeName].Value
      } else {
        $attribute = $SourceElement.OwnerDocument.CreateAttribute($attributeName)
        $attribute.Value = $TranslatedElement.Attributes[$attributeName].Value
        [void]$SourceElement.Attributes.Append($attribute)
      }
    }
  }

  $sourceChildren = New-Object System.Collections.ArrayList
  foreach ($child in $SourceElement.ChildNodes) {
    if ($child.NodeType -eq [System.Xml.XmlNodeType]::Element) {
      [void]$sourceChildren.Add([System.Xml.XmlNode]$child)
      continue
    }
    if (($child.NodeType -eq [System.Xml.XmlNodeType]::Text -or $child.NodeType -eq [System.Xml.XmlNodeType]::CDATA) -and -not [string]::IsNullOrWhiteSpace($child.Value)) {
      [void]$sourceChildren.Add([System.Xml.XmlNode]$child)
    }
  }

  $translatedChildren = New-Object System.Collections.ArrayList
  foreach ($child in $TranslatedElement.ChildNodes) {
    if ($child.NodeType -eq [System.Xml.XmlNodeType]::Element) {
      [void]$translatedChildren.Add([System.Xml.XmlNode]$child)
      continue
    }
    if (($child.NodeType -eq [System.Xml.XmlNodeType]::Text -or $child.NodeType -eq [System.Xml.XmlNodeType]::CDATA) -and -not [string]::IsNullOrWhiteSpace($child.Value)) {
      [void]$translatedChildren.Add([System.Xml.XmlNode]$child)
    }
  }

    $sourceChildCount = Get-CollectionCount $sourceChildren
  $translatedChildCount = Get-CollectionCount $translatedChildren
  if ($sourceChildCount -ne $translatedChildCount) {
    throw 'Translated fragment logical child count does not match the source fragment.'
  }

  for ($index = 0; $index -lt $sourceChildCount; $index += 1) {
    $sourceChild = [System.Xml.XmlNode]$sourceChildren[$index]
    $translatedChild = [System.Xml.XmlNode]$translatedChildren[$index]
    if (($sourceChild.NodeType -eq [System.Xml.XmlNodeType]::Text -or $sourceChild.NodeType -eq [System.Xml.XmlNodeType]::CDATA) -and
        ($translatedChild.NodeType -eq [System.Xml.XmlNodeType]::Text -or $translatedChild.NodeType -eq [System.Xml.XmlNodeType]::CDATA)) {
      $sourceChild.Value = $translatedChild.Value
      continue
    }
    if ($sourceChild.NodeType -eq [System.Xml.XmlNodeType]::Element -and $translatedChild.NodeType -eq [System.Xml.XmlNodeType]::Element) {
      Merge-TranslatedElement ([System.Xml.XmlElement]$sourceChild) ([System.Xml.XmlElement]$translatedChild)
      continue
    }
    throw 'Translated fragment node types do not align with the source fragment.'
  }
}

function Invoke-ParseMode {
  $normalizedTaskDir = [System.IO.Path]::GetFullPath($TaskDir)
  Ensure-Directory $normalizedTaskDir
  $sourceArchivePath = Join-Path $normalizedTaskDir 'source.epub'
  $extractRoot = Join-Path $normalizedTaskDir 'source'

  [System.IO.File]::Copy($InputPath, $sourceArchivePath, $true)
  Remove-DirectoryIfExists $extractRoot
  Ensure-Directory $extractRoot
  [System.IO.Compression.ZipFile]::ExtractToDirectory($sourceArchivePath, $extractRoot)

  $state = Validate-ExtractedEpub $extractRoot
  $blocks = New-Object System.Collections.Generic.List[object]
  $counters = @{}
  $script:CurrentOrder = 0
  $chapterIndex = 0

  foreach ($spineItem in $state.spine) {
    if ($spineItem.mediaType -ne 'application/xhtml+xml') {
      $chapterIndex += 1
      continue
    }
    $chapterDoc = Get-XmlDocumentFromFile $spineItem.absolutePath
    $bodyNode = $chapterDoc.SelectSingleNode('//*[local-name()="body"]')
    if ($null -eq $bodyNode) {
      $chapterIndex += 1
      continue
    }
    foreach ($child in (Get-ElementChildren $bodyNode)) {
      Visit-BodyElement $child $spineItem.href $chapterIndex $blocks $counters
    }
    $chapterIndex += 1
  }

  $combinedSource = (($blocks | ForEach-Object { $_.sourceMarkdown }) -join "`n`n").Trim()
  $paragraphCount = 0
  $translatableBlockCount = 0
  $skippedBlockCount = 0
  foreach ($block in $blocks) {
    if (@('heading', 'paragraph', 'list_item', 'blockquote') -contains [string]$block['type']) {
      $paragraphCount += 1
    }
    if ([bool]$block['shouldTranslate']) {
      $translatableBlockCount += 1
    } else {
      $skippedBlockCount += 1
    }
  }
  $parserInfo = [ordered]@{}
  $parserInfo['engine'] = 'epub-xhtml-xml'
  $parserInfo['version'] = '1.0.0'
  $parserInfo['astBacked'] = $true
  $parserInfo['roundTripStrategy'] = 'validated-xhtml-fragment-rewrite'
  $parserInfo['warnings'] = @()

  $statsInfo = [ordered]@{}
  $statsInfo['characters'] = $combinedSource.Length
  $statsInfo['paragraphs'] = $paragraphCount
  $statsInfo['blocks'] = Get-CollectionCount $blocks
  $statsInfo['translatableBlocks'] = $translatableBlockCount
  $statsInfo['skippedBlocks'] = $skippedBlockCount

  $assetInfo = [ordered]@{}
  $assetInfo['taskDir'] = $normalizedTaskDir
  $assetInfo['sourceArchivePath'] = $sourceArchivePath
  $assetInfo['extractRoot'] = $extractRoot
  $assetInfo['packagePath'] = $state.packageRelativePath
  $assetInfo['title'] = $state.title
  $assetInfo['language'] = $state.language
  $assetInfo['spineCount'] = Get-CollectionCount $state.spine

  $result = [ordered]@{}
  $result['parser'] = $parserInfo
  $result['stats'] = $statsInfo
  $result['sourcePreview'] = $combinedSource
  $result['asset'] = $assetInfo
  $result['blocks'] = $blocks.ToArray()
  Write-JsonFile $JsonPath $result
}

function Invoke-ValidateFragmentMode {
  $sourceFragment = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($SourceFragmentBase64))
  $translatedFragment = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($TranslatedFragmentBase64))
  $sourceDoc = Get-XmlDocumentFromString $sourceFragment
  $translatedDoc = Get-XmlDocumentFromString $translatedFragment
  if ($sourceDoc.DocumentElement.LocalName -ne $translatedDoc.DocumentElement.LocalName) {
    throw 'Translated fragment root tag does not match the source fragment.'
  }
  $sourceSignature = Get-StructureSignature $sourceDoc.DocumentElement
  $translatedSignature = Get-StructureSignature $translatedDoc.DocumentElement
  if ($sourceSignature -ne $translatedSignature) {
    throw 'Translated fragment structure does not match the source fragment.'
  }
  $blockType = Get-BlockType $translatedDoc.DocumentElement
  $preview = if ($null -ne $blockType) { Get-PreviewForBlock $translatedDoc.DocumentElement $blockType } else { Get-VisibleText $translatedDoc.DocumentElement }
  $result = [ordered]@{
    valid = $true
    normalizedFragment = $translatedDoc.DocumentElement.OuterXml
    previewText = $preview
    structureSignature = $translatedSignature
  }
  Write-JsonFile $JsonPath $result
}

function Invoke-ApplySegmentsMode {
  $sourceFragment = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($SourceFragmentBase64))
  $translatedSegmentsJson = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($TranslatedSegmentsBase64))
  $translatedSegments = $translatedSegmentsJson | ConvertFrom-Json
  $sourceDoc = Get-XmlDocumentFromString $sourceFragment
  Apply-TranslatedSegments $sourceDoc.DocumentElement $translatedSegments
  $blockType = Get-BlockType $sourceDoc.DocumentElement
  $preview = if ($null -ne $blockType) { Get-PreviewForBlock $sourceDoc.DocumentElement $blockType } else { Get-VisibleText $sourceDoc.DocumentElement }
  $result = [ordered]@{
    valid = $true
    normalizedFragment = $sourceDoc.DocumentElement.OuterXml
    previewText = $preview
    structureSignature = Get-StructureSignature $sourceDoc.DocumentElement
  }
  Write-JsonFile $JsonPath $result
}

function Invoke-ExportMode {
  $task = Read-JsonFile $TaskJsonPath
  $sourceRoot = $task.asset.extractRoot
  if (-not (Test-Path -LiteralPath $sourceRoot)) {
    throw 'EPUB source assets are missing for this task.'
  }

  $workingRoot = Join-Path ([System.IO.Path]::GetDirectoryName($OutputPath)) ('epub-build-' + [guid]::NewGuid().ToString())
  Ensure-Directory $workingRoot
  Copy-Item -LiteralPath $sourceRoot -Destination $workingRoot -Recurse -Force
  $activeRoot = Join-Path $workingRoot ([System.IO.Path]::GetFileName($sourceRoot))

  $chapterDocuments = @{}
  $packageFullPath = Join-Path $activeRoot ($task.asset.packagePath -replace '/', [System.IO.Path]::DirectorySeparatorChar)
  $packageDirectory = [System.IO.Path]::GetDirectoryName($packageFullPath)
  foreach ($block in $task.blocks) {
    if (-not $block.shouldTranslate) { continue }
    if ($block.status -notin @('translated', 'edited', 'retranslated')) { continue }
    if ($null -eq $block.translationUnit -or [string]::IsNullOrWhiteSpace($block.translationUnit.translatedFragment)) { continue }

    $chapterFullPath = Resolve-Href $packageDirectory $block.translationUnit.chapterPath
    if (-not $chapterDocuments.ContainsKey($chapterFullPath)) {
      $chapterDocuments[$chapterFullPath] = Get-XmlDocumentFromFile $chapterFullPath
    }
    $chapterDoc = $chapterDocuments[$chapterFullPath]
    $targetNode = Find-NodeByPath $chapterDoc $block.translationUnit.nodePath
    if ($null -eq $targetNode) {
      throw "EPUB export could not find block node $($block.translationUnit.nodePath) in $($block.translationUnit.chapterPath)."
    }
    $translatedDoc = Get-XmlDocumentFromString $block.translationUnit.translatedFragment
    Merge-TranslatedElement $targetNode $translatedDoc.DocumentElement
  }

  foreach ($entry in $chapterDocuments.GetEnumerator()) {
    Save-XmlDocument $entry.Value $entry.Key
  }

  Create-EpubZip $activeRoot $OutputPath

  $validationRoot = Join-Path $workingRoot 'validation'
  Ensure-Directory $validationRoot
  [System.IO.Compression.ZipFile]::ExtractToDirectory($OutputPath, $validationRoot)
  [void](Validate-ExtractedEpub $validationRoot)

  $sizeBytes = (Get-Item -LiteralPath $OutputPath).Length
  $result = [ordered]@{
    outputPath = $OutputPath
    sizeBytes = $sizeBytes
    valid = $true
  }
  Write-JsonFile $JsonPath $result
  Remove-DirectoryIfExists $workingRoot
}

switch ($Mode) {
  'parse' { Invoke-ParseMode; break }
  'validate-fragment' { Invoke-ValidateFragmentMode; break }
  'apply-segments' { Invoke-ApplySegmentsMode; break }
  'export' { Invoke-ExportMode; break }
  default { throw "Unsupported mode: $Mode" }
}






