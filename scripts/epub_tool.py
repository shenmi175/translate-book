#!/usr/bin/env python3

import argparse
import base64
import copy
import json
import os
import re
import shutil
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

XHTML_NS = "http://www.w3.org/1999/xhtml"
EPUB_NS = "http://www.idpf.org/2007/ops"

ET.register_namespace("", XHTML_NS)
ET.register_namespace("epub", EPUB_NS)


def ensure_directory(path_value):
    if path_value:
        Path(path_value).mkdir(parents=True, exist_ok=True)


def remove_directory_if_exists(path_value):
    if path_value and Path(path_value).exists():
        shutil.rmtree(path_value)


def write_json_file(path_value, value):
    ensure_directory(str(Path(path_value).parent))
    with open(path_value, "w", encoding="utf-8", newline="\n") as handle:
        json.dump(value, handle, ensure_ascii=False, indent=2)


def read_json_file(path_value):
    with open(path_value, "r", encoding="utf-8") as handle:
        return json.load(handle)


def local_name(tag):
    if not isinstance(tag, str):
        return ""
    if tag.startswith("{") and "}" in tag:
        return tag.split("}", 1)[1]
    return tag


def normalize_whitespace(value):
    if value is None:
        return ""
    normalized = re.sub(r"\s+", " ", str(value)).strip()
    return normalized


def normalize_preview_whitespace(value):
    if value is None:
        return ""
    normalized = re.sub(r"[^\S\n]+", " ", str(value))
    normalized = re.sub(r" *\n *", "\n", normalized)
    normalized = re.sub(r"\n{3,}", "\n\n", normalized)
    return normalized.strip()


def serialize_element(element):
    return ET.tostring(element, encoding="unicode", short_empty_elements=True)


def parse_xml_file(path_value):
    parser = ET.XMLParser()
    return ET.parse(path_value, parser=parser)


def parse_xml_string(xml_text):
    parser = ET.XMLParser()
    return ET.fromstring(xml_text, parser=parser)


def clone_element(element):
    return ET.fromstring(ET.tostring(element, encoding="utf-8"))


def get_element_children(node):
    return [child for child in list(node) if isinstance(child.tag, str)]


def get_collection_count(value):
    if value is None:
        return 0
    if isinstance(value, (list, tuple, dict, set)):
        return len(value)
    return 1


def structure_attribute_name(name):
    return local_name(name)


def build_logical_children_for_signature(element):
    children = []
    if normalize_whitespace(element.text):
        children.append(("#text", None))
    for child in get_element_children(element):
        children.append(("element", child))
        if normalize_whitespace(child.tail):
            children.append(("#text", None))
    return children


def get_structure_signature(node):
    if not isinstance(node.tag, str):
        return "#text"
    attribute_names = sorted(structure_attribute_name(name) for name in node.attrib.keys())
    child_signatures = []
    for kind, child in build_logical_children_for_signature(node):
        if kind == "#text":
            child_signatures.append("#text")
        else:
            child_signatures.append(get_structure_signature(child))
    attribute_part = ",".join(attribute_names)
    return f"<{local_name(node.tag)}|{attribute_part}>{''.join(child_signatures)}</{local_name(node.tag)}>"


def get_element_structure_signature(node):
    if not isinstance(node.tag, str):
        return ""
    attribute_names = sorted(structure_attribute_name(name) for name in node.attrib.keys())
    child_signatures = [get_element_structure_signature(child) for child in get_element_children(node)]
    attribute_part = ",".join(attribute_names)
    return f"<{local_name(node.tag)}|{attribute_part}>{''.join(child_signatures)}</{local_name(node.tag)}>"


def get_visible_text(node, preserve_breaks=False):
    parts = []

    def visit(element):
        if not isinstance(element.tag, str):
            return
        name = local_name(element.tag).lower()
        if name in {"script", "style"}:
            return
        if preserve_breaks and name == "br":
            parts.append("\n")
            return
        text_value = normalize_whitespace(element.text)
        if text_value:
            parts.append(text_value)
        if name == "img":
            alt_text = normalize_whitespace(element.attrib.get("alt", ""))
            if alt_text:
                parts.append(alt_text)
        for child in get_element_children(element):
            visit(child)
            tail_text = normalize_whitespace(child.tail)
            if tail_text:
                parts.append(tail_text)

    visit(node)
    joined = " ".join(parts)
    return normalize_preview_whitespace(joined) if preserve_breaks else joined.strip()


def build_segment_placeholder(index):
    return f"__MTS_SEG_{index:04d}__"


def get_translatable_segment_descriptors(root_element):
    segments = []

    def visit(element, current_path):
        title_text = normalize_whitespace(element.attrib.get("title", ""))
        if title_text:
            index = len(segments) + 1
            segments.append(
                {
                    "index": index,
                    "token": build_segment_placeholder(index),
                    "kind": "attribute",
                    "path": f"{current_path}/@title",
                    "attributeName": "title",
                    "sourceText": title_text,
                }
            )

        if local_name(element.tag).lower() == "img":
            alt_text = normalize_whitespace(element.attrib.get("alt", ""))
            if alt_text:
                index = len(segments) + 1
                segments.append(
                    {
                        "index": index,
                        "token": build_segment_placeholder(index),
                        "kind": "attribute",
                        "path": f"{current_path}/@alt",
                        "attributeName": "alt",
                        "sourceText": alt_text,
                    }
                )

        text_index = 0
        text_value = normalize_whitespace(element.text)
        if text_value:
            text_index += 1
            index = len(segments) + 1
            segments.append(
                {
                    "index": index,
                    "token": build_segment_placeholder(index),
                    "kind": "text",
                    "path": f"{current_path}/#text[{text_index}]",
                    "attributeName": "",
                    "sourceText": text_value,
                }
            )

        child_counts = {}
        for child in get_element_children(element):
            child_name = local_name(child.tag)
            child_counts[child_name] = child_counts.get(child_name, 0) + 1
            child_path = f"{current_path}/{child_name}[{child_counts[child_name]}]"
            visit(child, child_path)
            tail_value = normalize_whitespace(child.tail)
            if tail_value:
                text_index += 1
                index = len(segments) + 1
                segments.append(
                    {
                        "index": index,
                        "token": build_segment_placeholder(index),
                        "kind": "text",
                        "path": f"{current_path}/#text[{text_index}]",
                        "attributeName": "",
                        "sourceText": tail_value,
                    }
                )

    visit(root_element, f"/{local_name(root_element.tag)}[1]")
    return segments


def find_element_by_path(root_element, node_path):
    segments = [segment for segment in str(node_path).strip("/").split("/") if segment]
    current = root_element
    for index, segment in enumerate(segments):
        match = re.match(r"^(?P<name>[^\[]+)\[(?P<idx>\d+)\]$", segment)
        if not match:
            raise ValueError(f"Invalid node path segment: {segment}")
        name = match.group("name")
        target_index = int(match.group("idx"))
        if index == 0:
            if local_name(current.tag) != name or target_index != 1:
                return None
            continue

        count = 0
        next_element = None
        for child in get_element_children(current):
            if local_name(child.tag) != name:
                continue
            count += 1
            if count == target_index:
                next_element = child
                break
        current = next_element
        if current is None:
            return None
    return current


def get_text_slot_setter(element, text_index):
    current_index = 0
    if normalize_whitespace(element.text):
        current_index += 1
        if current_index == text_index:
            return ("text", element)
    for child in get_element_children(element):
        if normalize_whitespace(child.tail):
            current_index += 1
            if current_index == text_index:
                return ("tail", child)
    return None


def resolve_target_location(root_element, descriptor):
    if descriptor["kind"] == "attribute":
        element_path = descriptor["path"].split("/@", 1)[0]
        target = find_element_by_path(root_element, element_path)
        if target is None:
            raise ValueError(f"Could not resolve segment target: {descriptor['path']}")
        return ("attribute", target, descriptor["attributeName"])

    match = re.match(r"^(?P<element_path>.+)/#text\[(?P<index>\d+)\]$", descriptor["path"])
    if not match:
        raise ValueError(f"Invalid text target path: {descriptor['path']}")
    element_path = match.group("element_path")
    text_index = int(match.group("index"))
    target = find_element_by_path(root_element, element_path)
    if target is None:
        raise ValueError(f"Could not resolve text target: {descriptor['path']}")
    setter = get_text_slot_setter(target, text_index)
    if setter is None:
        raise ValueError(f"Could not resolve text slot: {descriptor['path']}")
    return setter


def write_target_location(location, value):
    kind, holder = location[:2]
    if kind == "attribute":
        attribute_name = location[2]
        holder.set(attribute_name, value)
        return
    if kind == "text":
        holder.text = value
    else:
        holder.tail = value


def set_target_value(root_element, descriptor, value):
    write_target_location(resolve_target_location(root_element, descriptor), value)


def get_target_value(root_element, descriptor):
    if descriptor["kind"] == "attribute":
        element_path = descriptor["path"].split("/@", 1)[0]
        target = find_element_by_path(root_element, element_path)
        if target is None:
            raise ValueError(f"Could not resolve segment target: {descriptor['path']}")
        return normalize_whitespace(target.attrib.get(descriptor["attributeName"], ""))

    match = re.match(r"^(?P<element_path>.+)/#text\[(?P<index>\d+)\]$", descriptor["path"])
    if not match:
        raise ValueError(f"Invalid text target path: {descriptor['path']}")
    element_path = match.group("element_path")
    text_index = int(match.group("index"))
    target = find_element_by_path(root_element, element_path)
    if target is None:
        raise ValueError(f"Could not resolve text target: {descriptor['path']}")
    setter = get_text_slot_setter(target, text_index)
    if setter is None:
        raise ValueError(f"Could not resolve text slot: {descriptor['path']}")
    kind, holder = setter
    raw_value = holder.text if kind == "text" else holder.tail
    return normalize_whitespace(raw_value)


def split_fallback_lines(value=""):
    return [line.strip() for line in str(value or "").replace("\r\n", "\n").split("\n") if line.strip()]


def split_text_proportionally(text, part_count, weights=None):
    if part_count <= 0:
        return []

    normalized = normalize_preview_whitespace(text)
    if part_count == 1:
        return [normalized]
    if not normalized:
        return [""] * part_count

    next_weights = list(weights or [])
    if len(next_weights) < part_count:
        next_weights.extend([1] * (part_count - len(next_weights)))
    next_weights = [max(1, int(weight or 1)) for weight in next_weights[:part_count]]

    def allocate(items, joiner):
        chunks = []
        start = 0
        remaining_items = len(items)
        remaining_weight = sum(next_weights) or part_count
        for index in range(part_count):
            if index == part_count - 1:
                chunks.append(joiner.join(items[start:]).strip())
                break
            slots_left = part_count - index
            weight = next_weights[index]
            target_count = round(remaining_items * weight / remaining_weight) if remaining_weight > 0 else 1
            target_count = max(1, int(target_count))
            target_count = min(target_count, remaining_items - (slots_left - 1))
            chunks.append(joiner.join(items[start : start + target_count]).strip())
            start += target_count
            remaining_items -= target_count
            remaining_weight -= weight
        while len(chunks) < part_count:
            chunks.append("")
        return chunks

    if " " in normalized:
        tokens = normalized.split()
        return allocate(tokens, " ")

    characters = list(normalized)
    return allocate(characters, "")


def build_safe_translated_segment_values(source_descriptors, fallback_text, block_type="", segment_template=""):
    if not source_descriptors:
        return []

    values = [str(descriptor.get("sourceText", "")) if descriptor.get("kind") == "attribute" else "" for descriptor in source_descriptors]
    text_indexes = [index for index, descriptor in enumerate(source_descriptors) if descriptor.get("kind") != "attribute"]
    normalized_fallback = normalize_preview_whitespace(fallback_text)

    if not text_indexes:
        if len(source_descriptors) == 1:
            values[0] = normalized_fallback
        return values

    if len(text_indexes) == 1:
        values[text_indexes[0]] = normalized_fallback
        return values

    line_aware = str(block_type or "").strip().lower() == "blockquote" or "<br" in str(segment_template or "").lower()
    lines = split_fallback_lines(normalized_fallback) if line_aware else []
    if line_aware and len(lines) > 1:
        for position, descriptor_index in enumerate(text_indexes):
            if position < len(lines) - 1:
                values[descriptor_index] = lines[position]
            elif position == len(text_indexes) - 1:
                values[descriptor_index] = " ".join(lines[position:]).strip()
            else:
                values[descriptor_index] = lines[position] if position < len(lines) else ""
        return values

    weights = [max(len(normalize_whitespace(source_descriptors[index].get("sourceText", ""))), 1) for index in text_indexes]
    chunks = split_text_proportionally(normalized_fallback, len(text_indexes), weights)
    for descriptor_index, chunk in zip(text_indexes, chunks):
        values[descriptor_index] = chunk
    return values


def repair_translated_root_for_export(block, source_element, translated_root):
    source_root = clone_element(source_element)
    translation_unit = block.get("translationUnit") or {}
    source_descriptors = list(translation_unit.get("segments") or get_translatable_segment_descriptors(source_root))
    translated_descriptors = get_translatable_segment_descriptors(translated_root)

    if source_descriptors and len(source_descriptors) == len(translated_descriptors):
        translated_values = [get_target_value(translated_root, descriptor) for descriptor in translated_descriptors]
        apply_translated_segments(source_root, translated_values)
        return source_root

    fallback_text = normalize_preview_whitespace(str(block.get("translatedMarkdown") or ""))
    if not fallback_text:
        fallback_text = get_visible_text(translated_root, preserve_breaks=True) or get_visible_text(source_root, preserve_breaks=True)

    if source_descriptors:
        translated_values = build_safe_translated_segment_values(
            source_descriptors,
            fallback_text,
            block.get("type", ""),
            translation_unit.get("segmentTemplate", ""),
        )
        apply_translated_segments(source_root, translated_values)
        return source_root

    source_root.text = fallback_text
    return source_root


def get_table_preview(element):
    lines = []
    for row in element.iter():
        if local_name(row.tag) != "tr":
            continue
        cells = []
        for cell in get_element_children(row):
            if local_name(cell.tag) not in {"th", "td"}:
                continue
            cell_text = get_visible_text(cell)
            if cell_text:
                cells.append(cell_text)
        if cells:
            lines.append(" | ".join(cells))
    return "\n".join(lines).strip()


def get_block_type(element):
    name = local_name(element.tag).lower()
    if name in {"h1", "h2", "h3", "h4", "h5", "h6"}:
        return "heading"
    if name == "p":
        return "paragraph"
    if name == "li":
        return "list_item"
    if name == "blockquote":
        return "blockquote"
    if name == "table":
        return "table"
    if name in {"pre", "code"}:
        return "fenced_code"
    if name in {"img", "figure"}:
        return "image"
    if name == "hr":
        return "thematic_break"
    return None


def get_preview_for_block(element, block_type):
    visible_text = get_visible_text(element, preserve_breaks=True)
    if block_type == "heading":
        level = 1
        name = local_name(element.tag).lower()
        if len(name) > 1 and name[1:].isdigit():
            level = int(name[1:])
        return (("#" * level) + " " + visible_text).strip()
    if block_type == "paragraph":
        return visible_text
    if block_type == "list_item":
        return ("- " + visible_text).strip()
    if block_type == "blockquote":
        return "\n".join((("> " + line) if line else ">") for line in visible_text.splitlines()).strip()
    if block_type == "table":
        return get_table_preview(element)
    if block_type == "fenced_code":
        return f"```\n{(element.text or '').strip()}\n```".strip()
    if block_type == "image":
        image_node = element
        if local_name(element.tag).lower() == "figure":
            for candidate in element.iter():
                if local_name(candidate.tag).lower() == "img":
                    image_node = candidate
                    break
        alt_text = image_node.attrib.get("alt", "")
        src_text = image_node.attrib.get("src", "")
        caption_text = ""
        for candidate in element.iter():
            if local_name(candidate.tag).lower() == "figcaption":
                caption_text = get_visible_text(candidate)
                break
        image_line = f"![{alt_text}]({src_text})"
        if caption_text:
            return (image_line + "\n" + caption_text).strip()
        return image_line.strip()
    if block_type == "thematic_break":
        return "---"
    return visible_text


def build_segment_templates(element, block_type):
    template_root = clone_element(element)
    descriptors = get_translatable_segment_descriptors(template_root)
    for descriptor in descriptors:
        set_target_value(template_root, descriptor, descriptor["token"])
    return {
        "segmentTemplate": serialize_element(template_root),
        "previewTemplate": get_preview_for_block(template_root, block_type),
    }


def apply_translated_segments(root_element, translated_segments):
    descriptors = get_translatable_segment_descriptors(root_element)
    if len(descriptors) != len(translated_segments):
        raise ValueError("Translated segment count does not match the source fragment.")
    target_locations = [resolve_target_location(root_element, descriptor) for descriptor in descriptors]
    for target_location, translated_value in zip(target_locations, translated_segments):
        write_target_location(target_location, str(translated_value))


def new_counter_id(counters, prefix):
    counters[prefix] = counters.get(prefix, 0) + 1
    return f"{prefix}-{counters[prefix]:03d}"


def get_block_prefix(block_type):
    return {
        "heading": "h",
        "paragraph": "p",
        "list_item": "li",
        "blockquote": "bq",
        "table": "tbl",
        "image": "img",
        "fenced_code": "code",
        "thematic_break": "hr",
    }.get(block_type, "blk")


def should_translate(block_type):
    return block_type in {"heading", "paragraph", "list_item", "blockquote", "table", "image"}


def get_skip_reason(block_type, has_translatable_content):
    if block_type == "fenced_code":
        return "Code-like XHTML blocks are skipped by default."
    if block_type == "thematic_break":
        return "Thematic breaks do not need translation."
    if not has_translatable_content:
        return "Block does not contain translatable visible text."
    return ""


def get_token_estimate(text):
    return max(1, (len(text) + 3) // 4)


def resolve_href(base_directory, href):
    clean_href = str(href or "").split("#", 1)[0].split("?", 1)[0]
    return str((Path(base_directory) / clean_href).resolve())


def get_relative_path(base_path, target_path):
    return os.path.relpath(target_path, base_path).replace(os.sep, "/")


def get_first_descendant_by_local_name(root, name):
    for candidate in root.iter():
        if local_name(candidate.tag) == name:
            return candidate
    return None


def get_descendants_by_local_name(root, name):
    return [candidate for candidate in root.iter() if local_name(candidate.tag) == name]


def get_text_content(root):
    return "".join(root.itertext()).strip()


def get_package_state(extracted_root):
    container_path = Path(extracted_root) / "META-INF" / "container.xml"
    if not container_path.exists():
        raise RuntimeError("EPUB is missing META-INF/container.xml.")
    container_doc = parse_xml_file(container_path).getroot()
    rootfile = None
    for candidate in container_doc.iter():
        if local_name(candidate.tag) == "rootfile":
            rootfile = candidate
            break
    if rootfile is None:
        raise RuntimeError("EPUB container.xml does not define a rootfile.")

    rootfile_path = rootfile.attrib.get("full-path", "").strip()
    if not rootfile_path:
        raise RuntimeError("EPUB container.xml does not define a rootfile.")

    package_full_path = (Path(extracted_root) / rootfile_path).resolve()
    package_doc = parse_xml_file(package_full_path).getroot()
    package_directory = package_full_path.parent

    manifest_by_id = {}
    for item in package_doc.iter():
        if local_name(item.tag) != "item":
            continue
        item_id = item.attrib.get("id", "").strip()
        href = item.attrib.get("href", "").strip()
        media_type = item.attrib.get("media-type", "").strip()
        if not item_id or not href:
            continue
        manifest_by_id[item_id] = {
            "href": href,
            "mediaType": media_type,
            "absolutePath": resolve_href(package_directory, href),
        }

    spine = []
    for item_ref in package_doc.iter():
        if local_name(item_ref.tag) != "itemref":
            continue
        idref = item_ref.attrib.get("idref", "").strip()
        if not idref:
            continue
        manifest_item = manifest_by_id.get(idref)
        if manifest_item is None:
            raise RuntimeError(f"EPUB spine itemref {idref} is missing from the manifest.")
        spine.append(
            {
                "idref": idref,
                "href": manifest_item["href"],
                "mediaType": manifest_item["mediaType"],
                "absolutePath": manifest_item["absolutePath"],
            }
        )

    metadata = get_first_descendant_by_local_name(package_doc, "metadata")
    title = ""
    language = ""
    if metadata is not None:
        title_node = get_first_descendant_by_local_name(metadata, "title")
        language_node = get_first_descendant_by_local_name(metadata, "language")
        title = get_text_content(title_node) if title_node is not None else ""
        language = get_text_content(language_node) if language_node is not None else ""

    return {
        "packageRelativePath": get_relative_path(extracted_root, package_full_path),
        "title": title,
        "language": language,
        "spine": spine,
    }


def validate_extracted_epub(extracted_root):
    mimetype_path = Path(extracted_root) / "mimetype"
    if not mimetype_path.exists():
        raise RuntimeError("EPUB is missing mimetype.")
    mimetype_value = mimetype_path.read_text(encoding="ascii").strip()
    if mimetype_value != "application/epub+zip":
        raise RuntimeError("EPUB mimetype must be application/epub+zip.")

    state = get_package_state(extracted_root)
    for spine_item in state["spine"]:
        absolute_path = Path(spine_item["absolutePath"])
        if not absolute_path.exists():
            raise RuntimeError(f"EPUB spine content is missing: {spine_item['href']}")
        if spine_item["mediaType"] == "application/xhtml+xml":
            parse_xml_file(absolute_path)
    return state


def create_epub_zip(source_directory, destination_path):
    destination = Path(destination_path)
    if destination.exists():
        destination.unlink()

    with zipfile.ZipFile(destination, "w") as archive:
        archive.write(Path(source_directory) / "mimetype", "mimetype", compress_type=zipfile.ZIP_STORED)
        for file_path in sorted(Path(source_directory).rglob("*")):
            if not file_path.is_file():
                continue
            relative_path = get_relative_path(source_directory, file_path)
            if relative_path == "mimetype":
                continue
            archive.write(file_path, relative_path, compress_type=zipfile.ZIP_DEFLATED)


def merge_translated_element(source_element, translated_element):
    if local_name(source_element.tag) != local_name(translated_element.tag):
        raise RuntimeError("Translated fragment root does not match the source fragment root.")
    if get_element_structure_signature(source_element) != get_element_structure_signature(translated_element):
        raise RuntimeError("Translated fragment structure does not match the source fragment.")

    for attribute_name in ("alt", "title"):
        if attribute_name in translated_element.attrib:
            source_element.set(attribute_name, translated_element.attrib[attribute_name])

    source_element.text = translated_element.text
    source_children = get_element_children(source_element)
    translated_children = get_element_children(translated_element)
    if len(source_children) != len(translated_children):
        raise RuntimeError("Translated fragment child count does not match the source fragment.")

    for source_child, translated_child in zip(source_children, translated_children):
        merge_translated_element(source_child, translated_child)
        source_child.tail = translated_child.tail


def find_parent_and_child_index(root_element, target_element):
    for parent in root_element.iter():
        children = list(parent)
        for index, child in enumerate(children):
            if child is target_element:
                return parent, index
    return None, -1


def mark_bilingual_translation_element(element):
    existing_class = str(element.attrib.get("class") or "").strip()
    class_names = existing_class.split() if existing_class else []
    if "mts-translation" not in class_names:
        class_names.append("mts-translation")
    element.set("class", " ".join(class_names))
    element.set("data-mts-role", "translation")


def insert_translated_element_after(root_element, source_element, translated_element):
    if local_name(source_element.tag) != local_name(translated_element.tag):
        raise RuntimeError("Translated fragment root does not match the source fragment root.")
    if get_element_structure_signature(source_element) != get_element_structure_signature(translated_element):
        raise RuntimeError("Translated fragment structure does not match the source fragment.")

    parent, index = find_parent_and_child_index(root_element, source_element)
    if parent is None or index < 0:
        raise RuntimeError("EPUB export could not resolve the translated block parent.")

    mark_bilingual_translation_element(translated_element)
    original_tail = source_element.tail
    source_element.tail = "\n"
    translated_element.tail = original_tail
    parent.insert(index + 1, translated_element)


def set_current_heading(current_heading_path, level, label):
    while len(current_heading_path) >= level:
        current_heading_path.pop()
    current_heading_path.append(label)


def new_block_object(element, block_type, chapter_path, chapter_index, counters, current_heading_path, order, node_path):
    preview = get_preview_for_block(element, block_type)
    source_text = get_visible_text(element)
    segments = get_translatable_segment_descriptors(element) if should_translate(block_type) else []
    segment_count = len(segments)
    has_translatable_content = segment_count > 0
    effective_translate = should_translate(block_type) and has_translatable_content
    templates = build_segment_templates(element, block_type) if effective_translate else None
    child_elements = get_element_children(element)
    text_only_fragment = effective_translate and len(child_elements) == 0 and segment_count == 1
    segment_mapped_fragment = effective_translate and segment_count > 0

    return {
        "id": new_counter_id(counters, get_block_prefix(block_type)),
        "type": block_type,
        "order": order,
        "headingPath": list(current_heading_path),
        "sourceMarkdown": preview,
        "translatedMarkdown": "" if effective_translate else preview,
        "status": "idle" if effective_translate else "skipped",
        "shouldTranslate": effective_translate,
        "skipped": not effective_translate,
        "skipReason": "" if effective_translate else get_skip_reason(block_type, has_translatable_content),
        "locked": False,
        "annotations": [],
        "comments": [],
        "retryCount": 0,
        "failureCount": 0,
        "tokenEstimate": get_token_estimate(preview),
        "separatorAfter": "\n\n",
        "errorMessage": "",
        "lastTranslatedAt": "",
        "lastEditedAt": "",
        "sourceRange": {
            "startLine": 0,
            "endLine": 0,
            "startOffset": 0,
            "endOffset": 0,
            "documentPath": chapter_path,
            "nodePath": node_path,
        },
        "translationUnit": {
            "mode": "epub_xhtml_fragment",
            "chapterPath": chapter_path,
            "chapterIndex": chapter_index,
            "nodePath": node_path,
            "sourceFragment": serialize_element(element),
            "sourceText": source_text,
            "textOnly": text_only_fragment,
            "segmentMapped": segment_mapped_fragment,
            "segments": segments,
            "segmentTemplate": templates["segmentTemplate"] if templates else "",
            "previewTemplate": templates["previewTemplate"] if templates else "",
            "translatedFragment": "",
            "structureSignature": get_structure_signature(element),
            "rootTag": local_name(element.tag),
        },
    }


def visit_body_element(element, chapter_path, chapter_index, blocks, counters, current_heading_path, state, node_path):
    block_type = get_block_type(element)
    if block_type is not None:
        if block_type == "heading":
            name = local_name(element.tag).lower()
            level = int(name[1:]) if len(name) > 1 and name[1:].isdigit() else 1
            set_current_heading(current_heading_path, level, get_visible_text(element))
        blocks.append(
            new_block_object(
                element,
                block_type,
                chapter_path,
                chapter_index,
                counters,
                current_heading_path,
                state["currentOrder"],
                node_path,
            )
        )
        state["currentOrder"] += 1
        return

    child_counts = {}
    for child in get_element_children(element):
        child_name = local_name(child.tag)
        child_counts[child_name] = child_counts.get(child_name, 0) + 1
        child_path = f"{node_path}/{child_name}[{child_counts[child_name]}]"
        visit_body_element(child, chapter_path, chapter_index, blocks, counters, current_heading_path, state, child_path)


def save_xml_document(tree, path_value):
    tree.write(path_value, encoding="utf-8", xml_declaration=True, short_empty_elements=True)


def invoke_parse_mode(args):
    normalized_task_dir = str(Path(args.task_dir).resolve())
    ensure_directory(normalized_task_dir)
    source_archive_path = str(Path(normalized_task_dir) / "source.epub")
    extract_root = str(Path(normalized_task_dir) / "source")

    shutil.copyfile(args.input_path, source_archive_path)
    remove_directory_if_exists(extract_root)
    ensure_directory(extract_root)
    with zipfile.ZipFile(source_archive_path, "r") as archive:
        archive.extractall(extract_root)

    state = validate_extracted_epub(extract_root)
    blocks = []
    counters = {}
    current_heading_path = []
    order_state = {"currentOrder": 0}
    chapter_index = 0

    for spine_item in state["spine"]:
        if spine_item["mediaType"] != "application/xhtml+xml":
            chapter_index += 1
            continue

        chapter_tree = parse_xml_file(spine_item["absolutePath"])
        chapter_root = chapter_tree.getroot()
        body_node = get_first_descendant_by_local_name(chapter_root, "body")
        if body_node is None:
            chapter_index += 1
            continue

        child_counts = {}
        for child in get_element_children(body_node):
            child_name = local_name(child.tag)
            child_counts[child_name] = child_counts.get(child_name, 0) + 1
            child_path = f"/{local_name(chapter_root.tag)}[1]/body[1]/{child_name}[{child_counts[child_name]}]"
            visit_body_element(
                child,
                spine_item["href"],
                chapter_index,
                blocks,
                counters,
                current_heading_path,
                order_state,
                child_path,
            )
        chapter_index += 1

    combined_source = "\n\n".join(block["sourceMarkdown"] for block in blocks).strip()
    paragraph_count = sum(1 for block in blocks if block["type"] in {"heading", "paragraph", "list_item", "blockquote"})
    translatable_block_count = sum(1 for block in blocks if block["shouldTranslate"])
    skipped_block_count = sum(1 for block in blocks if not block["shouldTranslate"])

    result = {
        "parser": {
            "engine": "epub-xhtml-xml-python",
            "version": "2.0.0",
            "astBacked": True,
            "roundTripStrategy": "validated-xhtml-fragment-rewrite",
            "warnings": [],
        },
        "stats": {
            "characters": len(combined_source),
            "paragraphs": paragraph_count,
            "blocks": len(blocks),
            "translatableBlocks": translatable_block_count,
            "skippedBlocks": skipped_block_count,
        },
        "sourcePreview": combined_source,
        "asset": {
            "taskDir": normalized_task_dir,
            "sourceArchivePath": source_archive_path,
            "extractRoot": extract_root,
            "packagePath": state["packageRelativePath"],
            "title": state["title"],
            "language": state["language"],
            "spineCount": len(state["spine"]),
        },
        "blocks": blocks,
    }
    write_json_file(args.json_path, result)


def invoke_validate_fragment_mode(args):
    source_fragment = base64.b64decode(args.source_fragment_base64).decode("utf-8")
    translated_fragment = base64.b64decode(args.translated_fragment_base64).decode("utf-8")
    source_root = parse_xml_string(source_fragment)
    translated_root = parse_xml_string(translated_fragment)
    if local_name(source_root.tag) != local_name(translated_root.tag):
        raise RuntimeError("Translated fragment root tag does not match the source fragment.")
    source_signature = get_structure_signature(source_root)
    translated_signature = get_structure_signature(translated_root)
    if source_signature != translated_signature:
        raise RuntimeError("Translated fragment structure does not match the source fragment.")
    block_type = get_block_type(translated_root)
    preview = get_preview_for_block(translated_root, block_type) if block_type is not None else get_visible_text(translated_root)
    write_json_file(
        args.json_path,
        {
            "valid": True,
            "normalizedFragment": serialize_element(translated_root),
            "previewText": preview,
            "structureSignature": translated_signature,
        },
    )


def invoke_apply_segments_mode(args):
    source_fragment = base64.b64decode(args.source_fragment_base64).decode("utf-8")
    translated_segments_json = base64.b64decode(args.translated_segments_base64).decode("utf-8")
    translated_segments = json.loads(translated_segments_json)
    source_root = parse_xml_string(source_fragment)
    apply_translated_segments(source_root, translated_segments)
    block_type = get_block_type(source_root)
    preview = get_preview_for_block(source_root, block_type) if block_type is not None else get_visible_text(source_root)
    write_json_file(
        args.json_path,
        {
            "valid": True,
            "normalizedFragment": serialize_element(source_root),
            "previewText": preview,
            "structureSignature": get_structure_signature(source_root),
        },
    )


def invoke_export_mode(args):
    task = read_json_file(args.task_json_path)
    layout = str(getattr(args, "layout", "") or "translation-only").strip().lower()
    if layout not in {"translation-only", "bilingual"}:
        raise RuntimeError("EPUB export layout must be translation-only or bilingual.")
    source_root = Path(task["asset"]["extractRoot"])
    if not source_root.exists():
        raise RuntimeError("EPUB source assets are missing for this task.")

    working_root = Path(args.output_path).parent / f"epub-build-{os.urandom(8).hex()}"
    ensure_directory(working_root)
    active_root = working_root / source_root.name
    shutil.copytree(source_root, active_root)

    chapter_documents = {}
    package_full_path = active_root / Path(task["asset"]["packagePath"])
    package_directory = package_full_path.parent

    try:
        export_blocks = list(task.get("blocks") or [])
        if layout == "bilingual":
            export_blocks.sort(key=lambda item: int(item.get("order") or 0), reverse=True)

        for block in export_blocks:
            if not block.get("shouldTranslate"):
                continue
            if block.get("status") not in {"translated", "edited", "retranslated"}:
                continue
            translation_unit = block.get("translationUnit") or {}
            translated_fragment = str(translation_unit.get("translatedFragment") or "").strip()
            if not translated_fragment:
                continue

            chapter_full_path = Path(resolve_href(package_directory, translation_unit.get("chapterPath", "")))
            chapter_key = str(chapter_full_path)
            if chapter_key not in chapter_documents:
                chapter_documents[chapter_key] = parse_xml_file(chapter_full_path)
            chapter_tree = chapter_documents[chapter_key]
            chapter_root = chapter_tree.getroot()
            target_node = find_element_by_path(chapter_root, translation_unit.get("nodePath", ""))
            if target_node is None:
                raise RuntimeError(
                    f"EPUB export could not find block node {translation_unit.get('nodePath')} in {translation_unit.get('chapterPath')}."
                )
            translated_root = parse_xml_string(translated_fragment)
            if (
                local_name(target_node.tag) != local_name(translated_root.tag)
                or get_structure_signature(target_node) != get_structure_signature(translated_root)
            ):
                translated_root = repair_translated_root_for_export(block, target_node, translated_root)
            if layout == "bilingual":
                insert_translated_element_after(chapter_root, target_node, translated_root)
            else:
                merge_translated_element(target_node, translated_root)

        for chapter_path, chapter_tree in chapter_documents.items():
            save_xml_document(chapter_tree, chapter_path)

        create_epub_zip(active_root, args.output_path)
        validation_root = working_root / "validation"
        ensure_directory(validation_root)
        with zipfile.ZipFile(args.output_path, "r") as archive:
            archive.extractall(validation_root)
        validate_extracted_epub(validation_root)
        size_bytes = Path(args.output_path).stat().st_size
        write_json_file(
            args.json_path,
            {
                "outputPath": args.output_path,
                "sizeBytes": size_bytes,
                "valid": True,
            },
        )
    finally:
        remove_directory_if_exists(working_root)


def build_parser():
    parser = argparse.ArgumentParser()
    parser.add_argument("--mode", required=True)
    parser.add_argument("--input-path")
    parser.add_argument("--task-dir")
    parser.add_argument("--json-path", required=True)
    parser.add_argument("--task-json-path")
    parser.add_argument("--output-path")
    parser.add_argument("--source-fragment-base64")
    parser.add_argument("--translated-fragment-base64")
    parser.add_argument("--translated-segments-base64")
    parser.add_argument("--layout", default="translation-only")
    return parser


def main():
    parser = build_parser()
    args = parser.parse_args()
    mode = args.mode

    if mode == "parse":
        invoke_parse_mode(args)
        return
    if mode == "validate-fragment":
        invoke_validate_fragment_mode(args)
        return
    if mode == "apply-segments":
        invoke_apply_segments_mode(args)
        return
    if mode == "export":
        invoke_export_mode(args)
        return
    raise RuntimeError(f"Unsupported mode: {mode}")


if __name__ == "__main__":
    main()
