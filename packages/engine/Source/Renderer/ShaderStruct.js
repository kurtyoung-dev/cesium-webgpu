/**
 * A utility for dynamically-generating a GLSL struct.
 *
 * @alias ShaderStruct
 *
 * @see {@link ShaderBuilder}
 * @param {string} name The name of the struct as it will appear in the shader.
 * @example
 * // Generate the struct:
 * //
 * // struct Attributes
 * // {
 * //     vec3 position;
 * //     vec3 normal;
 * //     vec2 texCoord;
 * // };
 * const struct = new ShaderStruct("Attributes");
 * struct.addField("vec3", "position");
 * struct.addField("vec3", "normal");
 * struct.addField("vec2", "texCoord");
 * const generatedLines = struct.generateGlslLines();
 *
 * @private
 */
class ShaderStruct {
  constructor(name) {
    this.name = name;
    this.fields = [];
  }

  /**
   * Add a field to the struct
   * @param {string} type The type of the struct field
   * @param {string} identifier The identifier of the struct field
   */
  addField(type, identifier) {
    const field = `    ${type} ${identifier};`;
    this.fields.push(field);
  }

  /**
   * Generate a list of lines of GLSL code for use with {@link ShaderBuilder}
   * @return {string[]} The generated GLSL code.
   */
  generateGlslLines() {
    const lines = [];
    lines.push(`struct ${this.name}`);
    lines.push("{");
    const fieldLength = this.fields.length;
    for (let i = 0; i < fieldLength; i++) {
      lines.push(this.fields[i]);
    }
    lines.push("};");
    lines.push("");
    return lines;
  }
}

export default ShaderStruct;
